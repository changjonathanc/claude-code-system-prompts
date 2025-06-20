#!/usr/bin/env node

// Test the actual extraction process like the HTML version does
const { DynamicPromptExtractor } = require('./script.js');

async function testRealExtraction() {
    console.log('🧪 Testing Real Extraction Process (like HTML version)\n');
    
    const extractor = new DynamicPromptExtractor();
    
    try {
        // Test extraction from a recent version (like the HTML does)
        console.log('📦 Extracting from real npm package...');
        const result = await extractor.extractPromptFromVersion('1.0.30');
        
        console.log('✅ Successfully extracted prompt!');
        console.log('📏 Length:', result.length, 'characters');
        console.log('🔍 First 200 characters:');
        console.log('─'.repeat(50));
        console.log(result.prompt.substring(0, 200) + '...');
        console.log('─'.repeat(50));
        
        // Check if it contains template variables
        const hasTemplateVars = result.prompt.includes('${');
        console.log('🔧 Contains template variables:', hasTemplateVars);
        
        if (hasTemplateVars) {
            console.log('📝 Template variables found in prompt:');
            const matches = result.prompt.match(/\$\{[^}]+\}/g);
            if (matches) {
                matches.forEach(match => console.log('  -', match));
            }
        }
        
    } catch (error) {
        console.error('❌ Error during real extraction:', error.message);
        console.error(error.stack);
    }
}

testRealExtraction();