import { describe, it, expect } from 'vitest'
import { Schmock } from './schmock'

describe('Schmock', () => {
  describe('constructor', () => {
    it('should create an instance with config', () => {
      const config: Schmock.Config = {
        routes: {
          '/api/test': { data: { message: 'test' } }
        }
      }
      const schmock = new Schmock(config)
      expect(schmock).toBeInstanceOf(Schmock)
    })
  })

  describe('get', () => {
    it('should return 200 with data for configured route', async () => {
      const config: Schmock.Config = {
        routes: {
          '/api/user': { data: { id: 1, name: 'John Doe' } }
        }
      }
      const schmock = new Schmock(config)
      const response = await schmock.get('/api/user')
      
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ id: 1, name: 'John Doe' })
      expect(response.headers['Content-Type']).toBe('application/json')
    })

    it('should return 404 for non-configured route', async () => {
      const config: Schmock.Config = {
        routes: {}
      }
      const schmock = new Schmock(config)
      const response = await schmock.get('/api/unknown')
      
      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'Not Found' })
    })

    it('should handle string data as route config', async () => {
      const config: Schmock.Config = {
        routes: {
          '/api/message': 'Hello World'
        }
      }
      const schmock = new Schmock(config)
      const response = await schmock.get('/api/message')
      
      expect(response.status).toBe(200)
      expect(response.body).toBe('Hello World')
    })
  })
})