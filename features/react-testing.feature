Feature: React Testing Utilities
  As a React test author
  I want the testing subpath to preserve provider lifecycle behavior
  So that convenience rendering does not weaken Schmock isolation

  Scenario: renderWithSchmock supplies the mock through context
    Given a mock for the React testing utility
    When I render a context consumer with renderWithSchmock
    Then the consumer should receive the same mock instance

  Scenario: Rerender preserves the provider context
    Given a rendered context consumer from renderWithSchmock
    When I rerender the consumer with different content
    Then the rerendered consumer should retain the same mock instance

  Scenario: Unmount restores fetch interception
    Given a mounted renderWithSchmock result
    When I unmount the testing result
    Then the original fetch implementation should be restored
