// Where the app is mounted, resolved at RUNTIME rather than baked in at build time.
//
// The same `dist/` has to work at `http://127.0.0.1:8011/` (local, no Apache) and at
// `https://host/webcip/` (behind the PHP site's Apache). A build-time base would mean two
// artifacts and a way to deploy the wrong one; deriving it here means one.
//
// `vite.config.ts` sets `base: './'`, which covers everything Vite emits (HTML, CSS url(),
// chunk preloads). These helpers cover what it cannot see: URLs built as strings in TS.

/** The URL directory the document was served from — '/' locally, '/webcip/' behind Apache.
 *
 *  Stable for the life of the page: the app uses HashRouter, so navigation only ever changes
 *  the fragment and `location.pathname` stays pinned to the mount point.
 *
 *  NOTE this reads the DIRECTORY, so it depends on the document URL ending in '/' or naming a
 *  file. `/webcip` with no trailing slash would resolve to '/' — hence the Apache redirect in
 *  deploy/apache-webcip.conf. Without it the page's own relative <script src> is broken before
 *  this code can run, so there is nothing to defend against here.
 */
export function mountFrom(href: string): string {
  const p = new URL(href).pathname;
  return p.endsWith('/') ? p : p.replace(/[^/]*$/, '');
}

export const MOUNT: string =
  typeof document === 'undefined' // vitest runs in a node environment
    ? '/'
    : mountFrom(document.baseURI);

/** A file served from frontend/public, e.g. asset('icons/crop.png'). */
export const asset = (rel: string) => MOUNT + rel;

/** The API root: '/api' locally, '/webcip/api' behind Apache. */
export const API = MOUNT + 'api';
