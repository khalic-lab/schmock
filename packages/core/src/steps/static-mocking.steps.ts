import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber'
import { expect, type TaskContext } from 'vitest'

const feature = await loadFeature('../../features/hello-world.feature')

describeFeature(feature, ({ Scenario }) => {
  Scenario('Mocking a GET request', ({ Given, When, Then, And }) => {
    let schmock: any
    let response: any

    Given('a Schmock instance with the following configuration:', (_, docString: string) => {
      const config = JSON.parse(docString)
      // For now, just create a mock object to see the test fail properly
      schmock = { config }
    })

    When('I make a GET request to "/api/user"', async () => {
      // This should fail since schmock.get doesn't exist yet
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
