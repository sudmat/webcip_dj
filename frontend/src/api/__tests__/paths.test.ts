import { describe, expect, it } from 'vitest';
import { mountFrom } from '../paths';

// The app has to serve from '/' locally and '/webcip/' behind Apache off ONE build, so every
// asset and API URL is built from this. Getting it wrong sends requests to the PHP site at the
// root, which answers 200 with HTML — so a mistake shows up as a JSON parse error, not a 404.
describe('mountFrom', () => {
  it('is the root when served from the root', () => {
    expect(mountFrom('http://127.0.0.1:8011/')).toBe('/');
    expect(mountFrom('http://127.0.0.1:8011/index.html')).toBe('/');
  });

  it('is the mount directory when served from a subpath', () => {
    expect(mountFrom('https://host/webcip/')).toBe('/webcip/');
    expect(mountFrom('https://host/webcip/index.html')).toBe('/webcip/');
  });

  it('ignores the hash — HashRouter puts every route there', () => {
    expect(mountFrom('https://host/webcip/#/display')).toBe('/webcip/');
    expect(mountFrom('http://127.0.0.1:8011/#/viewer')).toBe('/');
  });

  it('ignores a query string', () => {
    expect(mountFrom('https://host/webcip/?debug=1#/viewer')).toBe('/webcip/');
  });

  // Documents the one case the Apache redirect exists to prevent: without a trailing slash the
  // mount reads as the PARENT directory, so /webcip/api would be requested as /api.
  it('reads the parent directory when the trailing slash is missing', () => {
    expect(mountFrom('https://host/webcip')).toBe('/');
  });
});
