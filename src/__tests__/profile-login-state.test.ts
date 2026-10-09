import { describe, expect, it } from "bun:test"
import { applyApiRejected, applyLogin, applyObservation, applyProviderAccepted, applyRefreshRejected, applyRefreshSucceeded } from "../proxy/authLifecycle"
import { profileLoginState } from "../proxy/profileLoginState"

const START = 1_790_000_000_000

describe("authoritative profile login state", () => {
  it("keeps a refused grant logged out despite local credentials and a working access token", () => {
    const rejected = applyRefreshRejected(undefined, { at: START }).record
    const accepted = applyProviderAccepted(rejected, { at: START + 2, startedAt: START + 1 }).record

    const state = profileLoginState({ loggedIn: true, presence: "present", firstUnauthedAt: accepted.firstUnauthedAt })

    expect(state).toBe("needs_login")
    expect(accepted.unauthedReason).toBe("refresh_rejected")
  })

  it("keeps a transiently unreadable store distinct from absent credentials", () => {
    expect(profileLoginState({ loggedIn: true, presence: "unknown" })).toBe("authenticated")
    expect(profileLoginState({ presence: "unknown" })).toBe("unverified")
    expect(profileLoginState({ loggedIn: true, presence: "absent" })).toBe("needs_login")
  })

  it("does not erase a provider refusal when the same token remains on disk", () => {
    const rejected = applyApiRejected(undefined, { at: START + 1, startedAt: START }).record

    const observed = applyObservation(rejected, { at: START + 2, presence: "present" }).record

    expect(profileLoginState({ loggedIn: true, firstUnauthedAt: observed.firstUnauthedAt })).toBe("needs_login")
  })

  it("clears an access refusal only on a newer genuine provider acceptance", () => {
    const rejected = applyApiRejected(undefined, { at: START + 1, startedAt: START }).record

    const oldSuccess = applyProviderAccepted(rejected, { at: START + 2, startedAt: START }).record
    const newSuccess = applyProviderAccepted(rejected, { at: START + 3, startedAt: START + 2 }).record

    expect(oldSuccess.firstUnauthedAt).toBe(START + 1)
    expect(newSuccess.firstUnauthedAt).toBeUndefined()
  })

  it("ignores an old failure completing after a new login or refresh", () => {
    const loggedIn = applyLogin(undefined, { at: START + 1 }).record
    const refreshed = applyRefreshSucceeded(undefined, { at: START + 1 }).record

    const afterLogin = applyApiRejected(loggedIn, { at: START + 2, startedAt: START })
    const afterRefresh = applyApiRejected(refreshed, { at: START + 2, startedAt: START })

    expect(afterLogin.changed).toBe(false)
    expect(afterRefresh.changed).toBe(false)
  })

  it("upgrades a weaker refusal to a rejected grant without moving the first failure time", () => {
    const rejected = applyApiRejected(undefined, { at: START + 1, startedAt: START }).record

    const hard = applyRefreshRejected(rejected, { at: START + 2, detail: "invalid_grant" }).record
    const accepted = applyProviderAccepted(hard, { at: START + 4, startedAt: START + 3 }).record

    expect(accepted.firstUnauthedAt).toBe(START + 1)
    expect(accepted.unauthedReason).toBe("refresh_rejected")
  })

  it("clears a recorded refusal after a completed login or token refresh", () => {
    const rejected = applyRefreshRejected(undefined, { at: START }).record

    const loggedIn = applyLogin(rejected, { at: START + 1 }).record
    const refreshed = applyRefreshSucceeded(rejected, { at: START + 1 }).record

    expect(loggedIn.firstUnauthedAt).toBeUndefined()
    expect(refreshed.firstUnauthedAt).toBeUndefined()
  })
})
