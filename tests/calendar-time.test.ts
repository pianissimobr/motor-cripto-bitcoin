import { describe, expect, it } from 'vitest';
import { addCalendarDays } from '../src/core/domain/calendar-time.js';

describe('addCalendarDays', () => {
  it('soma 24 horas sem pular fim de semana', () => {
    const saturday = new Date('2026-10-24T15:00:00.000Z');
    expect(addCalendarDays(saturday, 1).toISOString()).toBe('2026-10-25T15:00:00.000Z');
  });

  it('soma dias corridos inclusive sobre feriado', () => {
    const friday = new Date('2026-10-23T21:00:00.000Z');
    expect(addCalendarDays(friday, 1).toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(addCalendarDays(friday, 3).toISOString()).toBe('2026-10-26T21:00:00.000Z');
  });

  it('dias=0 devolve o mesmo instante', () => {
    const date = new Date('2026-10-24T15:00:00.000Z');
    expect(addCalendarDays(date, 0).getTime()).toBe(date.getTime());
  });

  it('rejeita dias negativos ou fracionarios', () => {
    const date = new Date();
    expect(() => addCalendarDays(date, -1)).toThrow(/dias corridos invalidos/);
    expect(() => addCalendarDays(date, 1.5)).toThrow(/dias corridos invalidos/);
  });
});
