/**
 * Hold a redraw while text is being selected.
 *
 * Both live pages rebuild `#content` by assigning `innerHTML`, so every
 * selection inside it dies with the old nodes. The pages poll every ten
 * seconds, which is how a line vanishes from under the pointer mid-copy — and
 * on the landing page it is worse than cosmetic, because the whole card is a
 * switch button: the click that ENDS a drag-select lands on it, moves all
 * traffic to that account, and the redraw that follows takes the selection
 * away as well.
 *
 * Two things follow, and they are separate. A poll WAITS while a selection is
 * live. A click that merely finished one is not a click on the card.
 *
 * `reorderClientJs`'s pattern: this is the single browser-side copy, imported
 * as a string by whichever page needs it, so the two cannot drift.
 */

/**
 * How long a selection may hold the redraw off.
 *
 * Bounded rather than indefinite, because a selection is cleared by the next
 * click in the page and somebody who has moved to another window never makes
 * one — so an unbounded hold freezes the numbers silently, which is a worse
 * failure than losing a selection nobody is looking at any more. A minute is
 * six polls, and a copy takes seconds.
 */
export const SELECTION_HOLD_MAX_MS = 60_000

export const selectionHoldJs = `
var meridianSelection=(function(){
  var heldSince=0;
  var MAX_MS=${SELECTION_HOLD_MAX_MS};
  function live(){
    var sel=window.getSelection?window.getSelection():null;
    if(!sel||sel.isCollapsed||!sel.toString())return false;
    var content=document.getElementById('content');
    return !!(content&&sel.anchorNode&&content.contains(sel.anchorNode));
  }
  return {
    live:live,
    holdsRedraw:function(){
      if(!live()){heldSince=0;return false}
      var now=Date.now();
      if(!heldSince)heldSince=now;
      return now-heldSince<MAX_MS;
    }
  };
})();
`
