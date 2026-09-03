// Which loaded image plays which part.
//
// Two worlds, because the two ways a scene arrives label it differently:
//
//   A live pipeline session tags each image with a ROLE (backend/autoprocess.py's Run.preop /
//   .postop / .synthetic, mirroring projects/cip/__init__.py::_preop_ct / _postop_ct).
//
//   A .cdb or a saved plan carries no roles at all — projects/cip/cdb_scene.py builds the scene
//   from the file and identifies the pair by SLOT instead, which its own field comments spell
//   out: `top_id  # postop`, `bottom_id  # preop`, and for a preop-only cdb `top_id = preop`
//   with no bottom (cdb_scene.py:54-56, :260-271).
//
// So roles win when present, and the slots answer when they are not. A reviewer opening a .cdb
// is exactly the case the validation panel exists for, so the fallback is not an edge case.
import type { Image } from './image';

/** Just the parts of Scene these need — keeps them testable without constructing one. */
export interface Slots {
  images: Image[];
  top: Image | null;
  bottom: Image | null;
}

function byRole(images: Image[], role: string): Image | null {
  return images.find((im) => im.role === role) ?? null;
}

/** The image the preop steps act on: the synthetic stands in as the preop once it exists, else
 *  the preop-role image; failing any roles, the bottom slot (a .cdb pair) or the only image. */
export function preopImage(s: Slots): Image | null {
  return (
    byRole(s.images, 'synthetic') ??
    byRole(s.images, 'preop') ??
    s.bottom ?? // a pair with no roles: bottom is the preop
    s.top ??
    s.images[0] ??
    null
  );
}

/** The postop image, or null — a preop-only plan legitimately has none. Without roles, a pair
 *  puts the postop on top; a lone image is the preop, so there is no postop to return. */
export function postopImage(s: Slots): Image | null {
  return byRole(s.images, 'postop') ?? (s.bottom ? s.top : null);
}
