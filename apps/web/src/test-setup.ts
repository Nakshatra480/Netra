import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Vitest does not clear the DOM between tests unless globals are enabled, and
// leftover nodes make queries ambiguous.
afterEach(cleanup);
