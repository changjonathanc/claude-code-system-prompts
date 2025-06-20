#!/usr/bin/env node

// Test script for AST variable resolution
const fs = require('fs');
const path = require('path');

// Import our DynamicPromptExtractor
const { DynamicPromptExtractor } = require('./script.js');

async function testAST() {
    console.log('🧪 Testing AST Variable Resolution\n');
    
    const extractor = new DynamicPromptExtractor();
    
    // Read our test template file
    const testContent = fs.readFileSync('./test-template.js', 'utf8');
    
    console.log('📁 Test file content:');
    console.log('─'.repeat(50));
    console.log(testContent);
    console.log('─'.repeat(50));
    console.log();
    
    try {
        // Test 1: Extract main template with variables
        console.log('🔍 Test 1: Main template extraction');
        const result1 = await extractor.extractPrompt(testContent, 'You are an interactive CLI tool');
        console.log('Result:', result1 || 'Not found');
        console.log();
        
        // Test 2: Extract nested template with different scope
        console.log('🔍 Test 2: Nested template extraction');
        const result2 = await extractor.extractPrompt(testContent, 'Nested:');
        console.log('Result:', result2 || 'Not found');
        console.log();
        
        // Test 3: Extract help template
        console.log('🔍 Test 3: Help template extraction');
        const result3 = await extractor.extractPrompt(testContent, '/help: Get help');
        console.log('Result:', result3 || 'Not found');
        console.log();
        
    } catch (error) {
        console.error('❌ Error during testing:', error.message);
        console.error(error.stack);
    }
}

// Run the test
testAST().catch(console.error);