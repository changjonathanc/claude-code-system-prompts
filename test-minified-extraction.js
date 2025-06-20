#!/usr/bin/env node

// Test extraction from minified code (like real Claude Code CLI)
const { DynamicPromptExtractor } = require('./script.js');

const minifiedContent = `#!/usr/bin/env node
const $a0="IMPORTANT: Refuse to write code";
const x0="Claude Code";
const uW1="interactive CLI tool";
const template=\`You are an \${uW1} called \${x0}. 
\${$a0} or explain code that may be used maliciously.
- /help: Get help with using \${x0}\`;
console.log(template);`;

async function testMinifiedExtraction() {
    console.log('🧪 Testing Minified Code Extraction\n');
    
    const extractor = new DynamicPromptExtractor();
    
    console.log('📄 Minified content:');
    console.log('─'.repeat(50));
    console.log(minifiedContent);
    console.log('─'.repeat(50));
    console.log();
    
    try {
        // Test extraction
        const result = await extractor.extractPrompt(minifiedContent, 'You are an interactive CLI tool');
        console.log('✅ Result:', result || 'Not found');
        
        // Test with different search strings
        const result2 = await extractor.extractPrompt(minifiedContent, '/help: Get help');
        console.log('✅ Result 2:', result2 || 'Not found');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    }
}

testMinifiedExtraction();