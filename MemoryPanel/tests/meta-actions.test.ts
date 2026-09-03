import { describe, expect, it } from 'vitest';
import { ALLOWED_PANEL_ACTIONS } from '../src/panel/api/meta-actions.js';

describe('Panel metadata action boundary', () => {
  it('exposes fixed-asset reads but keeps direct binding writes behind business routes', () => {
    expect(ALLOWED_PANEL_ACTIONS.has('agent-fixed-asset/list')).toBe(true);
    expect(ALLOWED_PANEL_ACTIONS.has('agent-fixed-asset/list-with-detail')).toBe(true);
    expect(ALLOWED_PANEL_ACTIONS.has('agent-fixed-asset/set')).toBe(false);
  });
});
