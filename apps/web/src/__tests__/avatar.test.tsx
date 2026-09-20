import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from '@/components/Avatar';
import { usableImageUrl } from '@/lib/imageUrl';

/**
 * The account avatar.
 *
 * A remote photo fails for reasons the app cannot see: a privacy extension
 * blocking the image host, the CDN throttling a hotlinked avatar, a stale URL,
 * or being offline. None of those should ever surface as the browser's broken
 * image glyph, which reads as a fault in Netra.
 */

describe('usableImageUrl', () => {
  it('accepts a normal provider URL', () => {
    const url = 'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c';
    expect(usableImageUrl(url)).toBe(url);
  });

  it('rejects the values that produce a broken image', () => {
    // Each of these, handed to <img src>, resolves against the site's own
    // origin and fetches a page that does not exist.
    for (const value of ['', '   ', 'null', 'undefined', null, undefined, 42, {}]) {
      expect(usableImageUrl(value)).toBeNull();
    }
  });

  it('rejects a relative path, which is never a profile photo', () => {
    expect(usableImageUrl('/avatars/me.png')).toBeNull();
    expect(usableImageUrl('avatars/me.png')).toBeNull();
  });

  it('refuses a javascript: or data: source', () => {
    expect(usableImageUrl('javascript:alert(1)')).toBeNull();
    expect(usableImageUrl('data:image/svg+xml,<svg onload="alert(1)"/>')).toBeNull();
  });

  it('unwraps a claim the provider handed back as JSON', () => {
    // Some identity providers map `picture` to a document rather than a URL.
    expect(usableImageUrl('{"url":"https://example.com/a.png"}')).toBe('https://example.com/a.png');
    expect(usableImageUrl('{"data":{"url":"https://example.com/b.png"}}')).toBe(
      'https://example.com/b.png',
    );
    expect(usableImageUrl('{"data":{}}')).toBeNull();
    expect(usableImageUrl('{not json')).toBeNull();
  });
});

describe('Avatar', () => {
  it('shows the photo when there is a usable one', () => {
    const { container } = render(
      <Avatar src="https://lh3.googleusercontent.com/a/x=s96-c" initial="N" />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toContain('googleusercontent.com');
  });

  it('sends no referrer to the image host', () => {
    const { container } = render(<Avatar src="https://lh3.googleusercontent.com/a/x" initial="N" />);
    // Both a privacy measure and the conventional guard against a CDN
    // throttling hotlinked avatars.
    expect(container.querySelector('img')!.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('falls back to the initial when the image fails to load', () => {
    const { container } = render(<Avatar src="https://blocked.example/a.png" initial="N" />);
    fireEvent.error(container.querySelector('img')!);

    // No broken glyph: the element is replaced, not left failing.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('N')).toBeTruthy();
  });

  it('shows the initial immediately when there is no photo', () => {
    const { container } = render(<Avatar src={null} initial="D" />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('D')).toBeTruthy();
  });

  it('never renders an unusable claim as an image source', () => {
    for (const bad of ['null', '', '{"data":{}}', '/relative.png']) {
      const { container, unmount } = render(<Avatar src={bad} initial="N" />);
      expect(container.querySelector('img')).toBeNull();
      unmount();
    }
  });

  it('tries again when a different photo arrives', () => {
    const { container, rerender } = render(<Avatar src="https://a.example/1.png" initial="N" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    // A failure for one URL must not suppress the next one for the session.
    rerender(<Avatar src="https://b.example/2.png" initial="N" />);
    expect(container.querySelector('img')).toBeTruthy();
  });

  it('keeps the avatar out of the accessibility tree', () => {
    // The name sits beside it in text, so announcing the image adds noise.
    const { container } = render(<Avatar src="https://a.example/1.png" initial="N" />);
    expect(container.querySelector('img')!.getAttribute('alt')).toBe('');
  });
});
