/**
 * Both live pages carry one copy of the selection hold, and use it.
 *
 * The code itself is browser DOM work with no arithmetic to check, so what is
 * worth asserting is the WIRING: that each page interpolates the shared string
 * rather than growing its own, and that each poll actually consults it. A page
 * that ships the helper and never calls it looks identical from every angle
 * except the one that matters.
 */
import { describe, test, expect } from "bun:test"
import { SELECTION_HOLD_MAX_MS, selectionHoldJs } from "../telemetry/selectionHold"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

describe("selectionHoldJs", () => {
  test("carries the exported bound rather than a second copy of the number", () => {
    expect(selectionHoldJs).toContain(`var MAX_MS=${SELECTION_HOLD_MAX_MS};`)
  })

  test("a selection outside #content never holds anything", () => {
    // The pages replace #content and nothing else, so a selection in the
    // header or the nav survives a redraw on its own and must not stop one.
    expect(selectionHoldJs).toContain("content.contains(sel.anchorNode)")
  })
})

describe("the pages that redraw themselves", () => {
  for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
    test(`${name} ships the shared helper`, () => {
      expect(html).toContain("var meridianSelection=(function(){")
    })

    test(`${name} lets a live selection hold its poll`, () => {
      expect(html).toContain("!meridianSelection.holdsRedraw()")
    })
  }

  test("the landing page refuses the click that ends a drag-select", () => {
    // Every card there is a switch button, so without this the release of a
    // copy gesture moves all traffic to whichever account was being read.
    expect(landingHtml).toContain("if(meridianSelection.live())return;")
  })
})
