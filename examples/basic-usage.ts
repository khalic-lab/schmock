#!/usr/bin/env bun
import { Schmock } from '@schmock/core'

// Example 1: Basic static mocking
console.log('🎭 Schmock Basic Usage Examples\n')

// Simple configuration with static data
const schmock = new Schmock({
  routes: {
    '/api/users': {
      data: [
        { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com', role: 'user' },
        { id: 3, name: 'Bob Johnson', email: 'bob@example.com', role: 'user' }
      ]
    },
    '/api/users/1': {
      data: { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' }
    },
    '/api/config': {
      data: {
        appName: 'My App',
        version: '1.0.0',
        features: {
          darkMode: true,
          notifications: true,
          analytics: false
        }
      }
    },
    '/api/status': 'OK',
    '/api/health': {
      data: { status: 'healthy', uptime: 99.9 }
    }
  }
})

// Example requests
async function runExamples() {
  console.log('1️⃣  GET /api/users')
  const usersResponse = await schmock.get('/api/users')
  console.log(`   Status: ${usersResponse.status}`)
  console.log(`   Users: ${JSON.stringify(usersResponse.body, null, 2)}\n`)

  console.log('2️⃣  GET /api/users/1')
  const userResponse = await schmock.get('/api/users/1')
  console.log(`   Status: ${userResponse.status}`)
  console.log(`   User: ${JSON.stringify(userResponse.body, null, 2)}\n`)

  console.log('3️⃣  GET /api/config')
  const configResponse = await schmock.get('/api/config')
  console.log(`   Status: ${configResponse.status}`)
  console.log(`   Config: ${JSON.stringify(configResponse.body, null, 2)}\n`)

  console.log('4️⃣  GET /api/status (string response)')
  const statusResponse = await schmock.get('/api/status')
  console.log(`   Status: ${statusResponse.status}`)
  console.log(`   Body: "${statusResponse.body}"\n`)

  console.log('5️⃣  GET /api/unknown (404 example)')
  const notFoundResponse = await schmock.get('/api/unknown')
  console.log(`   Status: ${notFoundResponse.status}`)
  console.log(`   Error: ${JSON.stringify(notFoundResponse.body, null, 2)}\n`)
}

runExamples().catch(console.error)