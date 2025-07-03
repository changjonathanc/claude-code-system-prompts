const PROMPT_MARKERS = {
    systemPrompt: 'You are an interactive CLI tool',
    compactPrompt: 'Your task is to create a detailed summary of the conversation',
    bashPrompt: 'Executes a given bash command in a persistent shell',
    initPrompt: 'Please analyze this codebase and create a CLAUDE.md file',
    todoPrompt: 'Use this tool to create and manage a structured task list'
};

class DynamicPromptExtractor {
    constructor() {
        this.cache = new Map(); // Cache extracted prompts
        this.packageData = null;
    }

    // Simple TAR parser for browser (minimal implementation)
    parseTarBuffer(buffer) {
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

    async extractPrompt(content, searchString = 'You are an interactive CLI tool') {
        try {
            // Try AST parsing first for proper variable resolution
            const astResult = await this.extractPromptAST(content, searchString);
            if (astResult) {
                // Only log in debug mode or Node.js environment
                if (typeof window === 'undefined' || window.location.search.includes('debug=true')) {
                    console.log('✓ AST parsing successful with variable resolution');
                }
                return astResult;
            }

            // Fall back to simple string parsing if AST parsing fails
            return this.extractPromptSimple(content, searchString);
        } catch (error) {
            // Only log errors in debug mode
            if (typeof window === 'undefined' || window.location.search.includes('debug=true')) {
                console.warn('Extraction error:', error.message);
            }
            return this.extractPromptSimple(content, searchString);
        }
    }

    async extractPromptAST(content, searchString) {
        try {
            // Dynamic import acorn for proper AST parsing
            let acorn;
            if (typeof window !== 'undefined') {
                // Browser environment - use CDN
                acorn = await import('https://cdn.skypack.dev/acorn');
            } else {
                // Node.js environment - use local package
                acorn = await import('acorn');
            }

            // Preprocess content to handle shebangs and other issues
            const cleanContent = this.preprocessContent(content);

            // Try different parsing strategies for robustness
            let ast;
            const parseOptions = [
                // Modern module
                { ecmaVersion: 2022, sourceType: 'module', allowHashBang: true },
                // Modern script
                { ecmaVersion: 2022, sourceType: 'script', allowHashBang: true },
                // Legacy module
                { ecmaVersion: 2020, sourceType: 'module', allowHashBang: true },
                // Legacy script
                { ecmaVersion: 2020, sourceType: 'script', allowHashBang: true },
                // Very permissive
                { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReserved: true }
            ];

            for (const options of parseOptions) {
                try {
                    ast = acorn.parse(cleanContent, options);
                    break; // Success!
                } catch (parseError) {
                    // Try next option
                    continue;
                }
            }

            if (!ast) {
                throw new Error('All parsing strategies failed');
            }

            // Walk AST to find template literal containing searchString
            const result = this.findTemplateInAST(ast, cleanContent, searchString);
            if (!result) return null;

            // Build scope context at template position
            const scope = this.buildASTScope(ast, result.node);

            // Resolve template variables
            return this.resolveTemplateVariables(result.template, scope);
        } catch (error) {
            // Silently fail to reduce console noise, but keep for debugging
            if (typeof window !== 'undefined' && window.location.search.includes('debug=true')) {
                console.warn('AST parsing failed:', error.message);
            }
            return null; // Return null to trigger fallback
        }
    }

    preprocessContent(content) {
        let processed = content;

        // Remove shebang lines (#!/usr/bin/env node, etc.)
        if (processed.startsWith('#!')) {
            const firstNewline = processed.indexOf('\n');
            if (firstNewline !== -1) {
                processed = processed.substring(firstNewline + 1);
            }
        }

        // Handle other potential parsing issues
        // Remove UTF-8 BOM if present
        if (processed.charCodeAt(0) === 0xFEFF) {
            processed = processed.substring(1);
        }

        return processed;
    }

    extractPromptSimple(content, searchString = 'You are an interactive CLI tool') {
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

    findTemplateInAST(ast, content, searchString) {
        let result = null;

        const walk = (node, parent = null) => {
            if (!node || typeof node !== 'object') return;

            if (node.type === 'TemplateLiteral') {
                // Extract the template literal text from the source
                const templateText = content.substring(node.start, node.end);
                if (templateText.includes(searchString)) {
                    result = { node, template: templateText, parent };
                    return;
                }
            }

            // Recursively walk child nodes
            for (const key in node) {
                if (key === 'parent') continue; // Avoid circular references
                const child = node[key];
                if (Array.isArray(child)) {
                    child.forEach(grandchild => walk(grandchild, node));
                } else if (child && typeof child === 'object' && child.type) {
                    walk(child, node);
                }
            }
        };

        walk(ast);
        return result;
    }

    buildASTScope(ast, targetNode) {
        const scopes = [];
        let currentPath = [];

        const findNodePath = (node, path = []) => {
            if (node === targetNode) {
                currentPath = [...path, node];
                return true;
            }

            for (const key in node) {
                if (key === 'parent') continue;
                const child = node[key];
                if (Array.isArray(child)) {
                    for (let i = 0; i < child.length; i++) {
                        if (child[i] && typeof child[i] === 'object' && child[i].type) {
                            if (findNodePath(child[i], [...path, node])) {
                                return true;
                            }
                        }
                    }
                } else if (child && typeof child === 'object' && child.type) {
                    if (findNodePath(child, [...path, node])) {
                        return true;
                    }
                }
            }
            return false;
        };

        findNodePath(ast);

        // Build scope chain from root to target
        currentPath.forEach(node => {
            const scope = { vars: {}, node };

            // Extract variable declarations in this scope
            this.extractVariableDeclarations(node, scope);
            scopes.push(scope);
        });

        return scopes;
    }

    extractVariableDeclarations(node, scope) {
        if (!node || typeof node !== 'object') return;

        // Handle different types of variable declarations
        if (node.type === 'VariableDeclaration') {
            node.declarations.forEach(declarator => {
                if (declarator.id && declarator.id.type === 'Identifier' && declarator.init) {
                    const varName = declarator.id.name;
                    const value = this.extractLiteralValue(declarator.init);
                    if (value !== null) {
                        scope.vars[varName] = value;
                    }
                }
            });
        }

        // Handle function parameters
        if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
            if (node.params) {
                node.params.forEach(param => {
                    if (param.type === 'Identifier') {
                        scope.vars[param.name] = '<parameter>'; // Mark as parameter
                    }
                });
            }
        }

        // Recursively check child nodes in the same scope
        for (const key in node) {
            if (key === 'parent') continue;
            const child = node[key];

            // Don't descend into new scopes (functions, blocks with their own scope)
            if (child && typeof child === 'object' && child.type) {
                if (!this.createsNewScope(child.type)) {
                    this.extractVariableDeclarations(child, scope);
                }
            } else if (Array.isArray(child)) {
                child.forEach(grandchild => {
                    if (grandchild && typeof grandchild === 'object' && grandchild.type && !this.createsNewScope(grandchild.type)) {
                        this.extractVariableDeclarations(grandchild, scope);
                    }
                });
            }
        }
    }

    createsNewScope(nodeType) {
        return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'ForStatement', 'WhileStatement'].includes(nodeType);
    }

    extractLiteralValue(node) {
        if (!node) return null;

        switch (node.type) {
            case 'Literal':
                return node.value;
            case 'TemplateLiteral':
                // For simple template literals without expressions
                if (node.expressions.length === 0 && node.quasis.length === 1) {
                    return node.quasis[0].value.cooked;
                }
                return null;
            default:
                return null;
        }
    }

    resolveTemplateVariables(templateString, scopes) {
        return templateString.replace(/\$\{([^}]+)\}/g, (match, expression) => {
            const varName = expression.trim();

            // Look for variable in scope chain (innermost to outermost)
            for (let i = scopes.length - 1; i >= 0; i--) {
                const scope = scopes[i];
                if (scope.vars.hasOwnProperty(varName)) {
                    const value = scope.vars[varName];
                    if (value !== '<parameter>') {
                        return value;
                    }
                }
            }

            // Variable not found, return original
            return match;
        });
    }

    async getPackageMetadata() {
        if (this.packageData) {
            return this.packageData;
        }

        const response = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code');
        if (!response.ok) {
            throw new Error(`Failed to get package metadata: ${response.status}`);
        }

        this.packageData = await response.json();
        return this.packageData;
    }

    async extractPromptFromVersion(version) {
        // Check cache first
        if (this.cache.has(version)) {
            return this.cache.get(version);
        }

        console.log(`Extracting prompt for version ${version}...`);

        try {
            // Get package metadata
            const packageData = await this.getPackageMetadata();
            if (!packageData.versions[version]) {
                throw new Error(`Version ${version} not found`);
            }

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
            let pako;
            if (typeof window !== 'undefined') {
                pako = window.pako; // Browser environment – pako is global
            } else {
                pako = require('pako'); // Node.js fallback
            }
            const decompressed = pako.ungzip(uint8Array);

            // Parse TAR
            const files = this.parseTarBuffer(
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
                const prompt = await this.extractPrompt(content, marker);
                result[key] = prompt || null;
                const lenKey = key.replace('Prompt', 'Length');
                result[lenKey] = prompt ? prompt.length : 0;
            }

            if (!result.systemPrompt) {
                throw new Error(`No system prompt found in ${cliFile.name} for version ${version}`);
            }

            // Cache result
            this.cache.set(version, result);

            console.log(
                `✓ Extracted prompts for ${version} ` +
                    `(system: ${result.systemLength} chars, ` +
                    `compact: ${result.compactLength} chars, ` +
                    `bash: ${result.bashLength} chars, ` +
                    `init: ${result.initLength} chars, ` +
                    `todo: ${result.todoLength} chars)`
            );
            return result;
        } catch (error) {
            console.error(`Failed to extract prompt for ${version}:`, error);
            throw error;
        }
    }

    async getAvailableVersions() {
        const packageData = await this.getPackageMetadata();
        return Object.keys(packageData.versions).map(version => ({
            version,
            date: packageData.time[version] ? new Date(packageData.time[version]).toISOString().split('T')[0] : null
        })).sort((a, b) => {
            // Natural version sort
            const aMatch = a.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
            const bMatch = b.version.match(/^(\d+)\.(\d+)\.(\d+)$/);

            if (aMatch && bMatch) {
                const aMajor = parseInt(aMatch[1]);
                const aMinor = parseInt(aMatch[2]);
                const aPatch = parseInt(aMatch[3]);

                const bMajor = parseInt(bMatch[1]);
                const bMinor = parseInt(bMatch[2]);
                const bPatch = parseInt(bMatch[3]);

                if (aMajor !== bMajor) return aMajor - bMajor;
                if (aMinor !== bMinor) return aMinor - bMinor;
                return aPatch - bPatch;
            }

            return a.version.localeCompare(b.version);
        });
    }
}

class DiffReader {
    constructor(baseFile = null, compareFile = null) {
        this.files = [];
        this.fileContents = new Map();
        this.initialFiles = { base: baseFile, compare: compareFile };
        this.promptExtractor = new DynamicPromptExtractor();
        this.currentTab = 'system'; // 'system' or 'compact'

        this.elements = {
            file1Select: document.getElementById('file1'),
            file2Select: document.getElementById('file2'),
            diffContainer: document.getElementById('diff-container'),
            welcomeMessage: document.getElementById('welcome-message'),
            loading: document.getElementById('loading'),
            error: document.getElementById('error'),
            diffTable: document.querySelector('#diff-table tbody'),
            file1Name: document.getElementById('file1-name'),
            file2Name: document.getElementById('file2-name'),
            summary: document.getElementById('summary'),
            promptTabs: document.getElementById('prompt-tabs'),
            copyLeftBtn: document.getElementById('copy-left-btn'),
            copyRightBtn: document.getElementById('copy-right-btn')
        };

        this.init();
    }

    async init() {
        console.log('DiffReader init called - loading versions dynamically from npm');
        this.elements.diffContainer.style.display = 'none';
        this.elements.welcomeMessage.style.display = 'block';
        await this.loadFileList();
        this.setupEventListeners();
        this.setupTabs();
        this.setDefaultSelection();
        console.log('DiffReader init completed');
    }

    async loadFileList() {
        try {
            this.showLoading(`
                <strong>Loading available versions...</strong><br>
                <small>Fetching package metadata from npm registry</small>
            `);
            console.log('Loading available versions from npm registry...');

            const versions = await this.promptExtractor.getAvailableVersions();
            this.files = versions; // Now contains objects with version and date

            console.log(`Loaded ${this.files.length} versions from npm registry`);
            this.populateDropdowns();

        } catch (error) {
            console.error('Failed to load versions:', error);
            this.showError(`Failed to load versions: ${error.message}`);
        } finally {
            this.hideLoading();
        }
    }

    populateDropdowns() {
        const { file1Select, file2Select } = this.elements;

        console.log('Populating dropdowns with', this.files.length, 'files');

        // Clear dropdowns but keep placeholders
        file1Select.innerHTML = '<option value="">Base version...</option>';
        file2Select.innerHTML = '<option value="">Compare version...</option>';

        // Add file options
        this.files.forEach(fileInfo => {
            const displayText = fileInfo.date
                ? `${fileInfo.version} (${fileInfo.date})`
                : fileInfo.version;
            const option1 = new Option(displayText, fileInfo.version);
            const option2 = new Option(displayText, fileInfo.version);
            file1Select.appendChild(option1);
            file2Select.appendChild(option2);
        });

        console.log('Dropdowns populated. File1 has', file1Select.options.length, 'options');
    }


    setupEventListeners() {
        const onChange = () => {
            const { value: version1 } = this.elements.file1Select;
            const { value: version2 } = this.elements.file2Select;
            if (!version1 || !version2) return;
            if (version1 === version2) {
                this.showError('Pick two different versions.');
                this.elements.diffContainer.style.display = 'none';
                this.elements.welcomeMessage.style.display = 'block';
                return;
            }
            history.replaceState({}, '', `?base=${version1}&compare=${version2}`);
            this.compareFiles();
        };

        ['change', 'keydown'].forEach(ev => {
            this.elements.file1Select.addEventListener(ev, e => {
                if (e.type === 'change' || e.key === 'Enter') onChange();
            });
            this.elements.file2Select.addEventListener(ev, e => {
                if (e.type === 'change' || e.key === 'Enter') onChange();
            });
        });

        document.addEventListener('keyup', e => {
            if (e.target.tagName === 'SELECT') return;
            if (e.key === 'j') this.scrollLine(1);
            if (e.key === 'k') this.scrollLine(-1);
        });

        // Setup copy side buttons
        if (this.elements.copyLeftBtn) {
            this.elements.copyLeftBtn.addEventListener('click', () => this.copySideContent('left'));
        }
        if (this.elements.copyRightBtn) {
            this.elements.copyRightBtn.addEventListener('click', () => this.copySideContent('right'));
        }
    }

    setupTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const newTab = button.dataset.tab;
                if (newTab !== this.currentTab) {
                    this.switchTab(newTab);
                }
            });
        });
    }

    switchTab(tabType) {
        this.currentTab = tabType;

        // Update tab button states
        const tabButtons = document.querySelectorAll('.tab-button');
        tabButtons.forEach(button => {
            button.classList.toggle('active', button.dataset.tab === tabType);
        });

        // Re-run comparison if we have selections
        const version1 = this.elements.file1Select.value;
        const version2 = this.elements.file2Select.value;
        if (version1 && version2 && version1 !== version2) {
            this.compareFiles();
        }
    }

    setDefaultSelection() {
        if (this.initialFiles.base && this.initialFiles.compare) {
            this.elements.file1Select.value = this.initialFiles.base;
            this.elements.file2Select.value = this.initialFiles.compare;
            this.compareFiles();
        } else if (this.files.length >= 2) {
            const latest = this.files[this.files.length - 1];
            const secondLatest = this.files[this.files.length - 2];

            this.elements.file1Select.value = secondLatest.version;
            this.elements.file2Select.value = latest.version;

            this.compareFiles();
        }
    }

    async loadFileContent(version) {
        if (this.fileContents.has(version)) {
            return this.fileContents.get(version);
        }

        try {
            console.log(`Dynamically extracting prompt for ${version}...`);
            const result = await this.promptExtractor.extractPromptFromVersion(version);
            this.fileContents.set(version, result);

            return result;
        } catch (error) {
            console.error(`Error loading ${version}:`, error);
            this.showError(`Failed to load ${version}: ${error.message}`);
            throw error;
        }
    }

    async compareFiles() {
        const version1 = this.elements.file1Select.value;
        const version2 = this.elements.file2Select.value;

        if (!version1 || !version2 || version1 === version2) {
            return;
        }

        this.showLoading(`
            <strong>Extracting and comparing prompts...</strong><br>
            <small>Downloading npm packages, decompressing archives, parsing JavaScript, and resolving template variables</small>
        `);
        this.hideError();
        this.elements.welcomeMessage.style.display = 'none';
        this.elements.diffContainer.style.display = 'none';

        try {
            const [content1, content2] = await Promise.all([
                this.loadFileContent(version1),
                this.loadFileContent(version2)
            ]);

            // Determine which prompt to compare based on current tab
            let prompt1, prompt2, promptType;
            if (this.currentTab === 'compact') {
                prompt1 = content1.compactPrompt;
                prompt2 = content2.compactPrompt;
                promptType = 'Conversation Compacting';

                // Check if both versions have compact prompts
                if (!prompt1 || !prompt2) {
                    const missing = [];
                    if (!prompt1) missing.push(version1);
                    if (!prompt2) missing.push(version2);
                    throw new Error(`Conversation compacting prompt not found in version(s): ${missing.join(', ')}`);
                }
            } else if (this.currentTab === 'bash') {
                prompt1 = content1.bashPrompt;
                prompt2 = content2.bashPrompt;
                promptType = 'Bash Tools';

                // Check if both versions have bash prompts
                if (!prompt1 || !prompt2) {
                    const missing = [];
                    if (!prompt1) missing.push(version1);
                    if (!prompt2) missing.push(version2);
                    throw new Error(`Bash tools prompt not found in version(s): ${missing.join(', ')}`);
                }
            } else if (this.currentTab === 'init') {
                prompt1 = content1.initPrompt;
                prompt2 = content2.initPrompt;
                promptType = 'Init';

                if (!prompt1 || !prompt2) {
                    const missing = [];
                    if (!prompt1) missing.push(version1);
                    if (!prompt2) missing.push(version2);
                    throw new Error(`/init prompt not found in version(s): ${missing.join(', ')}`);
                }
            } else if (this.currentTab === 'todo') {
                prompt1 = content1.todoPrompt;
                prompt2 = content2.todoPrompt;
                promptType = 'Todo tool';

                if (!prompt1 || !prompt2) {
                    const missing = [];
                    if (!prompt1) missing.push(version1);
                    if (!prompt2) missing.push(version2);
                    throw new Error(`Todo list prompt not found in version(s): ${missing.join(', ')}`);
                }
            } else {
                prompt1 = content1.systemPrompt;
                prompt2 = content2.systemPrompt;
                promptType = 'System';
            }

            // Show tabs if at least one version has an alternate prompt (compact or bash)
            const hasAltPrompt =
                content1.compactPrompt ||
                content2.compactPrompt ||
                content1.bashPrompt ||
                content2.bashPrompt ||
                content1.initPrompt ||
                content2.initPrompt ||
                content1.todoPrompt ||
                content2.todoPrompt;
            this.elements.promptTabs.style.display = hasAltPrompt ? 'flex' : 'none';

            // Update file names in the diff header with character counts
            let char1, char2;
            if (this.currentTab === 'compact') {
                char1 = content1.compactLength;
                char2 = content2.compactLength;
            } else if (this.currentTab === 'bash') {
                char1 = content1.bashLength;
                char2 = content2.bashLength;
            } else if (this.currentTab === 'init') {
                char1 = content1.initLength;
                char2 = content2.initLength;
            } else if (this.currentTab === 'todo') {
                char1 = content1.todoLength;
                char2 = content2.todoLength;
            } else {
                char1 = content1.systemLength;
                char2 = content2.systemLength;
            }

            this.elements.file1Name.textContent = `${promptType} - Version ${version1} (${char1.toLocaleString()} characters)`;
            this.elements.file2Name.textContent = `${promptType} - Version ${version2} (${char2.toLocaleString()} characters)`;

            this.renderDiff(prompt1, prompt2);
            this.updateSummary();
        } catch (error) {
            this.showError(`Failed to load files: ${error.message}`);
        } finally {
            this.hideLoading();
        }
    }

    renderDiff(content1, content2) {
        const diff = this.computeDiff(content1, content2);

        const { diffTable } = this.elements;

        diffTable.innerHTML = '';

        // Ensure the container can expand to fit all content
        this.elements.diffContainer.style.height = 'auto';

        let line1 = 1;
        let line2 = 1;

        // Group consecutive changes for intelligent pairing
        const changeGroups = this.groupConsecutiveChanges(diff);

        changeGroups.forEach(group => {
            if (group.type === 'unchanged') {
                // Unchanged lines - show on both sides
                const lines = group.value.split('\n');
                lines.forEach((lineText, index) => {
                    if (index === lines.length - 1 && lineText === '') return;

                    const row = this.createTableRow(
                        this.createLine(line1++, lineText, 'context'),
                        this.createLine(line2++, lineText, 'context')
                    );
                    diffTable.appendChild(row);
                });
            } else if (group.type === 'change') {
                // Smart pairing of removed and added lines
                const removedLines = group.removed.split('\n').filter(line => line !== '');
                const addedLines = group.added.split('\n').filter(line => line !== '');
                const maxLines = Math.max(removedLines.length, addedLines.length);

                for (let i = 0; i < maxLines; i++) {
                    const removedLine = removedLines[i] || '';
                    const addedLine = addedLines[i] || '';

                    let leftContent, rightContent;

                    if (removedLine && addedLine) {
                        // Both exist - pair them to show the change
                        leftContent = this.createLine(line1++, removedLine, 'removed');
                        rightContent = this.createLine(line2++, addedLine, 'added');
                    } else if (removedLine) {
                        // Only removed line
                        leftContent = this.createLine(line1++, removedLine, 'removed');
                        rightContent = this.createLine('', '', 'empty');
                    } else if (addedLine) {
                        // Only added line
                        leftContent = this.createLine('', '', 'empty');
                        rightContent = this.createLine(line2++, addedLine, 'added');
                    }

                    const row = this.createTableRow(leftContent, rightContent);
                    diffTable.appendChild(row);
                }
            } else if (group.type === 'removed') {
                // Only removed lines
                const lines = group.value.split('\n');
                lines.forEach((lineText, index) => {
                    if (index === lines.length - 1 && lineText === '') return;

                    const row = this.createTableRow(
                        this.createLine(line1++, lineText, 'removed'),
                        this.createLine('', '', 'empty')
                    );
                    diffTable.appendChild(row);
                });
            } else if (group.type === 'added') {
                // Only added lines
                const lines = group.value.split('\n');
                lines.forEach((lineText, index) => {
                    if (index === lines.length - 1 && lineText === '') return;

                    const row = this.createTableRow(
                        this.createLine('', '', 'empty'),
                        this.createLine(line2++, lineText, 'added')
                    );
                    diffTable.appendChild(row);
                });
            }
        });

        this.elements.diffContainer.style.display = 'block';
    }

    groupConsecutiveChanges(diff) {
        const groups = [];
        let i = 0;

        while (i < diff.length) {
            const change = diff[i];

            if (!change.added && !change.removed) {
                // Unchanged block
                groups.push({ type: 'unchanged', value: change.value });
                i++;
            } else if (change.removed) {
                // Look for consecutive removed and added changes to pair them
                let removedText = change.value;
                let addedText = '';
                i++;

                // Check if the next change is an addition
                if (i < diff.length && diff[i].added) {
                    addedText = diff[i].value;
                    // This is a change block (removed + added)
                    groups.push({ type: 'change', removed: removedText, added: addedText });
                    i++;
                } else {
                    // Only removed, no corresponding addition
                    groups.push({ type: 'removed', value: removedText });
                }
            } else if (change.added) {
                // Added block with no corresponding removal
                groups.push({ type: 'added', value: change.value });
                i++;
            }
        }

        return groups;
    }

    renderWordDiffHTML(wordDiff, lineType) {
        return wordDiff.map(part => {
            if (!part.added && !part.removed) {
                // Unchanged word
                return this.escapeHtml(part.value);
            } else if ((lineType === 'removed' && part.removed) || (lineType === 'added' && part.added)) {
                // Highlight this word
                return `<span class="word-diff">${this.escapeHtml(part.value)}</span>`;
            } else {
                // Don't show this word (it belongs to the other side)
                return '';
            }
        }).join('');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    createLine(lineNumber, content, type) {
        const line = document.createElement('div');
        line.className = `line ${type}`;

        const lineNum = document.createElement('div');
        lineNum.className = 'line-number';
        lineNum.textContent = lineNumber;

        const lineContent = document.createElement('div');
        lineContent.className = 'line-content';
        lineContent.textContent = content;

        line.appendChild(lineNum);
        line.appendChild(lineContent);

        return line;
    }

    createLineWithHTML(lineNumber, htmlContent, type) {
        const line = document.createElement('div');
        line.className = `line ${type}`;

        const lineNum = document.createElement('div');
        lineNum.className = 'line-number';
        lineNum.textContent = lineNumber;

        const lineContent = document.createElement('div');
        lineContent.className = 'line-content';
        lineContent.innerHTML = htmlContent;

        line.appendChild(lineNum);
        line.appendChild(lineContent);

        return line;
    }

    createTableRow(leftContent, rightContent) {
        const row = document.createElement('tr');

        const leftCell = document.createElement('td');
        leftCell.appendChild(leftContent);

        const rightCell = document.createElement('td');
        rightCell.appendChild(rightContent);

        row.appendChild(leftCell);
        row.appendChild(rightCell);

        return row;
    }

    computeDiff(text1, text2) {
        if (!window.Diff) {
            throw new Error('Diff library not loaded');
        }
        return window.Diff.diffLines(text1, text2, { newlineIsToken: false, ignoreWhitespace: false });
    }

    showLoading(message = null) {
        if (message) {
            const loadingText = this.elements.loading.querySelector('span');
            if (loadingText) {
                loadingText.innerHTML = message;
            }
        }
        this.elements.loading.style.display = 'flex';
    }

    hideLoading() {
        this.elements.loading.style.display = 'none';
    }

    showError(message) {
        const errorElement = this.elements.error;
        errorElement.textContent = message;
        errorElement.style.display = 'block';
    }

    hideError() {
        this.elements.error.style.display = 'none';
    }

    updateSummary() {
        const added = this.elements.diffTable.querySelectorAll('.line.added').length;
        const removed = this.elements.diffTable.querySelectorAll('.line.removed').length;
        if (added > 0 || removed > 0) {
            this.elements.summary.textContent = `${added} line${added !== 1 ? 's' : ''} added, ${removed} removed`;
            this.elements.summary.style.display = 'block';
        } else {
            this.elements.summary.style.display = 'none';
        }
    }

    scrollLine(dir) {
        const sel = '.line.added,.line.removed';
        const lines = [...document.querySelectorAll(sel)];
        const top = window.scrollY;
        const next = dir > 0
            ? lines.find(l => l.offsetTop > top + 5)
            : [...lines].reverse().find(l => l.offsetTop < top - 5);
        if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    copySideContent(side) {
        try {
            // Get all table rows
            const rows = this.elements.diffTable.querySelectorAll('tr');
            const content = [];

            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                    const targetCell = side === 'left' ? cells[0] : cells[1];
                    const lineContent = targetCell.querySelector('.line-content');
                    if (lineContent && lineContent.textContent.trim()) {
                        content.push(lineContent.textContent);
                    }
                }
            });

            const textToCopy = content.join('\n');
            const button = side === 'left' ? this.elements.copyLeftBtn : this.elements.copyRightBtn;

            this.copyToClipboard(textToCopy, button);

        } catch (error) {
            console.error('Failed to copy side content:', error);
            this.showError(`Failed to copy ${side} side content: ${error.message}`);
        }
    }

    copyToClipboard(text, button) {
        if (!text.trim()) {
            this.showError('No content to copy');
            return;
        }

        // Try modern clipboard API first
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                this.showCopySuccess(button);
            }).catch((err) => {
                console.error('Clipboard API failed:', err);
                this.fallbackCopy(text, button);
            });
        } else {
            this.fallbackCopy(text, button);
        }
    }

    fallbackCopy(text, button) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'absolute';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            const successful = document.execCommand('copy');
            if (successful) {
                this.showCopySuccess(button);
            } else {
                throw new Error('execCommand failed');
            }
        } catch (fallbackErr) {
            console.error('Fallback copy failed:', fallbackErr);
            this.showCopyError(button);
        } finally {
            document.body.removeChild(textArea);
        }
    }

    showCopySuccess(button) {
        button.innerHTML = '<i class="fas fa-check"></i>';
        button.classList.add('copied');

        setTimeout(() => {
            button.innerHTML = '<i class="fas fa-copy"></i>';
            button.classList.remove('copied');
        }, 2000);
    }

    showCopyError(button) {
        button.innerHTML = '<i class="fas fa-times"></i>';

        setTimeout(() => {
            button.innerHTML = '<i class="fas fa-copy"></i>';
        }, 2000);
    }

}

// Browser-only code
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
    // Wait for both Diff library and pako to be available
    const waitForLibraries = () => {
        if (window.Diff && window.pako) {
            const params = new URLSearchParams(location.search);
            new DiffReader(params.get('base'), params.get('compare'));
        } else {
            setTimeout(waitForLibraries, 50);
        }
    };
    waitForLibraries();

    // Setup copy button
    const copyBtn = document.getElementById('copy-install-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', copyInstallCommand);
        console.log('Copy button event listener attached');
    }

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const savedTheme = localStorage.getItem('theme');

        const applyTheme = (theme) => {
            const isLight = theme === 'light';
            document.body.classList.toggle('light', isLight);
            themeToggle.checked = isLight;
        };

        applyTheme(savedTheme ? savedTheme : (prefersDark ? 'dark' : 'light'));

        themeToggle.addEventListener('change', () => {
            const newTheme = themeToggle.checked ? 'light' : 'dark';
            applyTheme(newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }
    });
}

// Copy install command function (browser-only)
function copyInstallCommand() {
    if (typeof window === 'undefined') return;
    const command = 'npm install -g @anthropic-ai/claude-code';
    const button = document.getElementById('copy-install-btn');

    console.log('Copy function called, command:', command);
    console.log('Button found:', button);

    if (!button) {
        console.error('Copy button not found');
        return;
    }

    // Try modern clipboard API first
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(command).then(() => {
            console.log('Clipboard API success');
            button.innerHTML = '<i class="fas fa-check"></i>';
            button.classList.add('copied');

            setTimeout(() => {
                button.innerHTML = '<i class="fas fa-copy"></i>';
                button.classList.remove('copied');
            }, 2000);
        }).catch((err) => {
            console.error('Clipboard API failed:', err);
            fallbackCopy();
        });
    } else {
        console.log('Using fallback copy method');
        fallbackCopy();
    }

    function fallbackCopy() {
        const textArea = document.createElement('textarea');
        textArea.value = command;
        textArea.style.position = 'absolute';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            const successful = document.execCommand('copy');
            console.log('Fallback copy result:', successful);

            if (successful) {
                button.innerHTML = '<i class="fas fa-check"></i>';
                button.classList.add('copied');

                setTimeout(() => {
                    button.innerHTML = '<i class="fas fa-copy"></i>';
                    button.classList.remove('copied');
                }, 2000);
            } else {
                throw new Error('execCommand failed');
            }
        } catch (fallbackErr) {
            console.error('Fallback copy failed:', fallbackErr);
            button.innerHTML = '<i class="fas fa-times"></i>';

            setTimeout(() => {
                button.innerHTML = '<i class="fas fa-copy"></i>';
            }, 2000);
        } finally {
            document.body.removeChild(textArea);
        }
    }
}

// Export classes for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DynamicPromptExtractor, DiffReader };
}

// Also make available as ES modules
if (typeof window === 'undefined') {
    // Node.js environment
    global.DynamicPromptExtractor = DynamicPromptExtractor;
    global.DiffReader = DiffReader;
} else {
    // Browser environment - also export for ES modules
    window.DynamicPromptExtractor = DynamicPromptExtractor;
    window.DiffReader = DiffReader;
}