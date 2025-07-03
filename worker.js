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
    bashPrefixPrompt: 'This document defines risk levels for actions that the'
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
            const prompt = extractPromptSimple(content, marker);
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