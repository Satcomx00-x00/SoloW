/**
 * The two zoom levels the canvas is built around, kept together because they have to agree.
 *
 * Below `COMPACT_ZOOM` a Step node stops being a form and becomes a card that only *says* what
 * the Step is — contextual zoom, the React Flow pattern for exactly this. The node graph's
 * problem at six Steps was never the graph, it was that every node drew its whole form at every
 * zoom: three selects, a prompt, two library pickers and a branch, times six, is a wall of
 * controls with the pipeline somewhere behind it. Zoomed out nobody is editing a gate; they are
 * reading the shape of the pipeline, and the fields are noise at a size where they cannot be
 * read anyway. 0.72 rather than a round number: it is just under the zoom a fit settles on for a
 * four-Step pipeline in an ordinary region.
 *
 * `FIT_VIEW` is what every automatic fit uses — the first paint, a resize, the secondary panel
 * toggling, and the `+` that adds a Step. Its floor is the compact threshold, not something
 * below it: a fit that stepped back past the editable zoom handed the operator a card they had
 * just added and could not name — the fields were gone, and nothing on screen said why. The
 * branching control check hit exactly that with five Steps in a narrow region. A pipeline too
 * long to fit at the editable zoom is shown from its start instead (the canvas pans to it), and
 * stepping back to take the whole shape in is the operator's gesture, never the fit's.
 */
export const COMPACT_ZOOM = 0.72;

export const FIT_VIEW = { padding: 0.15, maxZoom: 1, minZoom: COMPACT_ZOOM } as const;
