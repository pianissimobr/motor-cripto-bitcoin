/**
 * Janela de liquidacao em dias corridos.
 *
 * Nao ha calendario de feriados nem diferenca entre dias uteis e fins de
 * semana: `days = 1` significa exatamente 24 horas depois do fim da pagina.
 * O horario e preservado e o calculo e feito em milissegundos para nao
 * depender do fuso do processo.
 */
export function addCalendarDays(date: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`dias corridos invalidos: ${days}`);
  }
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
