#!/usr/bin/env node

/**
 * Clean generated files from source directories
 * This prevents stale transpiled files from interfering with development
 */

const { existsSync, readdirSync, statSync, unlinkSync } = require('fs');
const { join, extname } = require('path');

const PACKAGES_DIR = join(process.cwd(), 'packages');
const GENERATED_EXTENSIONS = ['.js', '.d.ts'];
const IGNORE_PATTERNS = ['.test.js', '.spec.js', '.steps.js'];

function shouldRemove(file) {
  const ext = extname(file);
  if (!GENERATED_EXTENSIONS.includes(ext)) return false;
  
  // Check if it's a test file we should keep
  for (const pattern of IGNORE_PATTERNS) {
    if (file.endsWith(pattern)) return false;
  }
  
  return true;
}

function cleanDirectory(dir) {
  if (!existsSync(dir)) return;
  
  const entries = readdirSync(dir);
  let cleaned = 0;
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Don't clean node_modules or dist directories
      if (entry !== 'node_modules' && entry !== 'dist') {
        cleaned += cleanDirectory(fullPath);
      }
    } else if (shouldRemove(entry)) {
      console.log(`Removing: ${fullPath}`);
      unlinkSync(fullPath);
      cleaned++;
    }
  }
  
  return cleaned;
}

// Clean all package src directories
if (existsSync(PACKAGES_DIR)) {
  const packages = readdirSync(PACKAGES_DIR);
  let totalCleaned = 0;
  
  for (const pkg of packages) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src');
    if (existsSync(srcDir)) {
      console.log(`\nCleaning ${pkg}/src...`);
      const cleaned = cleanDirectory(srcDir);
      totalCleaned += cleaned;
    }
  }
  
  console.log(`\n✓ Cleaned ${totalCleaned} generated files`);
} else {
  console.error('No packages directory found');
  process.exit(1);
}