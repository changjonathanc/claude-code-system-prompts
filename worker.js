// worker.js - Web Worker for heavy processing
// This worker handles downloading, decompressing, and parsing npm packages

// Import pako for gzip decompression
importScripts('https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js');

// Prompt markers (duplicated from main script for worker isolation)
const PROMPT_MARKERS = {
    systemPrompt: 'You are an interactive CLI tool',
    compactPrompt: 'Your task is to create a detailed summary of the conversation',
    bashPrompt: 'Executes a given bash command in a persistent shell',
    initPrompt: 'Please analyze this codebase and create a CLAUDE.md file',
    todoPrompt: 'Use this tool to create and manage a structured task list',
    bashPrefixPrompt: 'This document defines risk levels for actions that the',
    autoClassifierPrompt: 'You are a security monitor for autonomous AI coding agents',
    autoAgentPrompt: 'Auto mode is active. The user chose continuous, autonomous execution'
};

// Simple TAR parser for browser (minimal implementation)
function parseTarBuffer(buffer) {
    const files = [];
    const view = new Uint8Array(buffer);
    let offset = 0;

    while (offset < view.length) {
        // TAR header is 512 bytes
        if (offset + 512 > view.length) break;

        // Check for end of archive (two consecutive zero blocks)
        const isZeroBlock = view.slice(offset, offset + 512).every(byte => byte === 0);
        if (isZeroBlock) break;

        // Parse TAR header
        const nameBytes = view.slice(offset, offset + 100);
        const name = new TextDecoder().decode(nameBytes).replace(/\0.*$/, '');

        if (!name) {
            offset += 512;
            continue;
        }

        // Get file size (octal string at offset 124, 12 bytes)
        const sizeBytes = view.slice(offset + 124, offset + 136);
        const sizeStr = new TextDecoder().decode(sizeBytes).replace(/\0.*$/, '').replace(/\s/g, '');
        const size = parseInt(sizeStr, 8) || 0;

        // Get file type (offset 156)
        const typeFlag = String.fromCharCode(view[offset + 156]);

        offset += 512; // Skip header

        if (typeFlag === '0' || typeFlag === '' || typeFlag === '\0') { // Regular file
            const content = view.slice(offset, offset + size);
            files.push({
                name: name,
                content: content,
                size: size
            });
        }

        // Round up to next 512-byte boundary
        const paddedSize = Math.ceil(size / 512) * 512;
        offset += paddedSize;
    }

    return files;
}

// Extract template literal content starting before the given marker
// Returns the content between backticks (without the backticks), or null
function extractTemplateLiteralContent(content, marker) {
    const index = content.indexOf(marker);
    if (index === -1) return null;

    let start = index;
    while (start > 0 && content[start] !== '`') {
        start--;
    }
    if (content[start] !== '`') return null;

    let end = index + marker.length;
    let depth = 0;
    while (end < content.length) {
        if (content[end] === '`' && depth === 0) break;
        else if (content[end] === '$' && content[end + 1] === '{') { depth++; end += 2; }
        else if (content[end] === '}' && depth > 0) { depth--; end++; }
        else if (content[end] === '\\') end += 2;
        else end++;
    }
    if (end >= content.length) return null;
    return content.substring(start + 1, end); // Strip surrounding backticks
}

// Extract the string value of a variable like:  varName="....." or varName='.....'
function extractStringVarValue(content, marker) {
    // Try double-quoted string containing the marker
    const idx = content.indexOf('"' + marker);
    if (idx !== -1) {
        let end = idx + 1;
        while (end < content.length) {
            if (content[end] === '"' && content[end - 1] !== '\\') break;
            end++;
        }
        if (end < content.length) return content.substring(idx + 1, end);
    }
    return null;
}

// Extract all significant string literals from a function body and format them as a list
// functionMarker should uniquely identify the function (e.g. a string inside it)
function extractArraySectionContent(content, functionMarker, sectionHeader) {
    const markerIdx = content.indexOf(functionMarker);
    if (markerIdx === -1) return null;

    // Walk back to find the enclosing function's opening brace
    let fnStart = markerIdx;
    while (fnStart > 0 && content[fnStart] !== '{') fnStart--;

    // Walk forward to find the matching closing brace
    let depth = 1, i = fnStart + 1;
    while (i < content.length && depth > 0) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') depth--;
        i++;
    }
    const fnBody = content.substring(fnStart, i);

    // Extract all string literals longer than 20 chars from the array
    const strings = [];
    let j = 0;
    while (j < fnBody.length) {
        const ch = fnBody[j];
        if (ch === '"' || ch === "'" || ch === '`') {
            let end = j + 1;
            while (end < fnBody.length) {
                if (fnBody[end] === ch && fnBody[end - 1] !== '\\') break;
                if (ch === '`' && fnBody[end] === '$' && fnBody[end + 1] === '{') {
                    let d = 1; end += 2;
                    while (end < fnBody.length && d > 0) {
                        if (fnBody[end] === '{') d++;
                        else if (fnBody[end] === '}') d--;
                        end++;
                    }
                    continue;
                }
                if (fnBody[end] === '\\') end++;
                end++;
            }
            const str = fnBody.substring(j + 1, end)
                .replace(/\\"/g, '"')
                .replace(/\\'/g, "'")
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t');
            if (str.length > 20 && !str.includes('${')) strings.push(str);
            j = end + 1;
        } else {
            j++;
        }
    }

    if (strings.length === 0) return null;
    const items = strings.map(s => ` - ${s}`).join('\n');
    return sectionHeader ? `${sectionHeader}\n${items}` : items;
}

// Extract the full system prompt from the new multi-section format (v2.1.71+)
// Returns combined string, or null if this format is not detected
function extractFullSystemPrompt(content) {
    // Detect new format by presence of TL1 identity string
    const TL1_MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";
    if (!content.includes(TL1_MARKER)) return null;

    const sections = [];

    // 1. TL1: first-line identity ("You are Claude Code, Anthropic's official CLI for Claude.")
    sections.push(TL1_MARKER);

    // 2. ulK: security policy string constant
    const ulkStart = content.indexOf('ulK="');
    const ulkEnd = ulkStart !== -1 ? content.indexOf('"', ulkStart + 5) : -1;
    const ulK = (ulkStart !== -1 && ulkEnd !== -1) ? content.substring(ulkStart + 5, ulkEnd) : '';

    // 3. UpY section: main instruction template literal
    let upySection = extractTemplateLiteralContent(content, 'You are an interactive agent that helps users');
    if (upySection) {
        // Resolve the conditional expression (default to software engineering tasks)
        upySection = upySection.replace(
            /\$\{q!==null\?'[^']*':"with software engineering tasks\."\}/g,
            'with software engineering tasks.'
        );
        // Resolve ${ulK}
        upySection = upySection.replace(/\$\{ulK\}/g, ulK);
        // Drop any remaining unresolved template expressions
        upySection = upySection.replace(/\$\{[^}]+\}/g, '');
        sections.push(upySection.trim());
    }

    // 4. QpY section: # System (string array)
    const qpySection = extractArraySectionContent(
        content, 'All text you output outside of tool use is displayed to the user', '# System'
    );
    if (qpySection) sections.push(qpySection);

    // 5. dpY section: # Doing tasks (string array)
    const dpySection = extractArraySectionContent(
        content, "Don't add features, refactor code", '# Doing tasks'
    );
    if (dpySection) sections.push(dpySection);

    // 6. cpY section: # Executing actions with care (template literal)
    const cpySection = extractTemplateLiteralContent(content, '# Executing actions with care');
    if (cpySection) sections.push(cpySection.trim());

    // 7. apY section: # Tone and style (string array)
    const apySection = extractArraySectionContent(
        content, 'Your responses should be short and concise', '# Tone and style'
    );
    if (apySection) sections.push(apySection);

    // 8. opY section: # Output efficiency (template literal)
    const opySection = extractTemplateLiteralContent(content, '# Output efficiency');
    if (opySection) sections.push(opySection.trim());

    if (sections.length <= 1) return null; // Only TL1 found, not the new format
    return sections.join('\n\n');
}

// Simple prompt extraction (fallback method for worker)
function extractPromptSimple(content, searchString) {
    const index = content.indexOf(searchString);
    if (index === -1) {
        return null;
    }

    // Look for template literal backticks first (most common case)
    let start = index;
    while (start > 0 && content[start] !== '`') {
        start--;
    }

    if (content[start] === '`') {
        // Found template literal, find the closing backtick
        let end = index + searchString.length;
        let depth = 0;

        while (end < content.length) {
            if (content[end] === '`' && depth === 0) {
                break;
            } else if (content[end] === '$' && content[end + 1] === '{') {
                depth++;
                end += 2;
            } else if (content[end] === '}' && depth > 0) {
                depth--;
                end++;
            } else if (content[end] === '\\') {
                end += 2; // Skip escaped character
            } else {
                end++;
            }
        }

        if (end < content.length) {
            return content.substring(start, end + 1);
        }
    }

    // Fall back to quote-based parsing
    start = index;
    while (start > 0 && !['`', '"', "'"].includes(content[start])) {
        start--;
    }

    if (start === 0 && !['`', '"', "'"].includes(content[start])) {
        return null;
    }

    const startChar = content[start];
    let end = index + searchString.length;

    while (end < content.length) {
        if (content[end] === startChar) {
            break;
        } else if (content[end] === '\\') {
            end += 2; // Skip escaped character
        } else {
            end++;
        }
    }

    if (end >= content.length) {
        return null;
    }

    return content.substring(start, end + 1);
}

// Extract prompt from version (main worker function)
async function extractPromptFromVersion(version, packageData) {
    try {
        // Get tarball URL
        const tarballUrl = packageData.versions[version].dist.tarball;

        // Download tarball
        const tarballResponse = await fetch(tarballUrl);
        if (!tarballResponse.ok) {
            throw new Error(`Failed to download tarball: ${tarballResponse.status}`);
        }

        const tarballData = await tarballResponse.arrayBuffer();

        // Decompress gzip
        const uint8Array = new Uint8Array(tarballData);
        const decompressed = pako.ungzip(uint8Array);

        // Parse TAR
        const files = parseTarBuffer(
            decompressed.buffer.slice(
                decompressed.byteOffset,
                decompressed.byteOffset + decompressed.byteLength
            )
        );

        // Locate CLI file
        const cliFile = files.find(f => f.name === 'package/cli.js' || f.name === 'package/cli.mjs');
        if (!cliFile) {
            throw new Error(`No CLI file found in version ${version}`);
        }

        // Extract prompts via the marker map
        const content = new TextDecoder().decode(cliFile.content);
        const result = {};

        for (const [key, marker] of Object.entries(PROMPT_MARKERS)) {
            let prompt;
            if (key === 'systemPrompt') {
                // Try new multi-section format first (v2.1.71+), fall back to old single-literal format
                prompt = extractFullSystemPrompt(content) || extractPromptSimple(content, marker);
            } else {
                prompt = extractPromptSimple(content, marker);
            }
            result[key] = prompt || null;
            const lenKey = key.replace('Prompt', 'Length');
            result[lenKey] = prompt ? prompt.length : 0;
        }

        if (!result.systemPrompt) {
            throw new Error(`No system prompt found in ${cliFile.name} for version ${version}`);
        }

        return result;
    } catch (error) {
        throw new Error(`Failed to extract prompt for ${version}: ${error.message}`);
    }
}

// Worker message handler
self.onmessage = async function(e) {
    const { type, version, packageData, requestId } = e.data;
    
    try {
        if (type === 'extractPrompt') {
            const result = await extractPromptFromVersion(version, packageData);
            
            // Send success response
            self.postMessage({
                type: 'success',
                requestId,
                version,
                result
            });
        } else {
            throw new Error(`Unknown message type: ${type}`);
        }
    } catch (error) {
        // Send error response
        self.postMessage({
            type: 'error',
            requestId,
            version,
            error: error.message
        });
    }
};

// Send ready signal
self.postMessage({ type: 'ready' });