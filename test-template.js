// Test file to verify AST variable resolution
const v0 = "Claude Code";
const toolName = "interactive CLI tool";

function createPrompt() {
    const prompt = `You are an ${toolName} called ${v0}. 
- /help: Get help with using ${v0}
- Follow user instructions carefully`;
    
    return prompt;
}

// Nested scope test
function outerFunction() {
    const v0 = "Outer Value";
    
    function innerFunction() {
        const v1 = "Inner Value";
        const nestedPrompt = `Nested: ${v0} and ${v1}`;
        return nestedPrompt;
    }
    
    return innerFunction();
}

module.exports = { createPrompt, outerFunction };