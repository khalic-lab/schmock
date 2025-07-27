import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber'
import { expect, type TaskContext } from 'vitest'
import { Schmock } from '../index'

const feature = await loadFeature('../../features/hello-world.feature')

describeFeature(feature, ({ Scenario }) => {
  Scenario('Mocking a GET request', ({ Given, When, Then, And }) => {
    let schmock: any
    let response: any

    Given('a Schmock instance with the following configuration:', (_, docString: string) => {
      const config = JSON.parse(docString)
      schmock = new Schmock(config)
    })

    When('I make a GET request to "/api/user"', async () => {
      response = await schmock.get("/api/user")
    })

    Then('the response status code should be 200', () => {
      expect(response.status).toBe(200)
    })

    And('the response body should be:', (_, docString: string) => {
      expect(response.body).toEqual(JSON.parse(docString))
    })
  })
})
