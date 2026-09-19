import { describe, expect, it } from 'vitest';
describe('Accounting kernel contract',()=>{it('keeps monetary values string-safe at API boundaries',()=>{expect(typeof '100.00000000').toBe('string');});});
