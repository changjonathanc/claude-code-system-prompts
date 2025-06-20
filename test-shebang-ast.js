#!/usr/bin/env node

// Test shebang handling
const fs = require('fs');
const { DynamicPromptExtractor } = require('./script.js');

async function testShebang() {
    const extractor = new DynamicPromptExtractor();
    const content = fs.readFileSync('./test-shebang.js', 'utf8');
    
    console.log('🧪 Testing shebang handling');
    console.log('Content:', content.substring(0, 100) + '...');
    
    try {
        const result = await extractor.extractPrompt(content, 'Welcome to');
        console.log('✓ Result:', result);
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testShebang();