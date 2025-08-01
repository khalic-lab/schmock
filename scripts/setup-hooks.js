#!/usr/bin/env node
/**
 * Setup Git hooks for the project
 * Run with: node scripts/setup-hooks.js
 */

const { execSync } = require('child_process');
const path = require('path');

try {
    console.log('🔧 Setting up Git hooks...');
    
    // Set Git hooks path to our custom directory
    execSync('git config core.hooksPath .githooks', { 
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit' 
    });
    
    console.log('✅ Git hooks configured successfully!');
    console.log('');
    console.log('📋 Available hooks:');
    console.log('  • pre-commit: Runs linting and tests before commit');
    console.log('  • commit-msg: Enforces conventional commit format');
    console.log('');
    console.log('💡 To bypass hooks (not recommended): git commit --no-verify');
    
} catch (error) {
    console.error('❌ Failed to setup Git hooks:', error.message);
    process.exit(1);
}