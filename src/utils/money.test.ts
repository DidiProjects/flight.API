import { describe, it, expect } from 'vitest'
import { toCents, fromCents, sumMoney, isCheaperBy } from './money'

describe('toCents / fromCents', () => {
  it('converte no centavo e volta', () => {
    expect(toCents(2367.15)).toBe(236715)
    expect(toCents(0.1)).toBe(10)
    expect(toCents(0)).toBe(0)
    expect(fromCents(236715)).toBe(2367.15)
  })

  it('arredonda a fração de centavo em vez de truncar', () => {
    expect(toCents(1178.544)).toBe(117854)
    expect(toCents(1178.545)).toBe(117855)
    expect(toCents(1178.546)).toBe(117855)
  })

  // 1.005 * 100 is 100.49999999999999 in binary: without trimming the dust
  // first, this would round DOWN to 100 cents where the column stores 101.
  it('não deixa o erro binário vazar para os centavos', () => {
    expect(toCents(10.17)).toBe(1017)
    expect(toCents(29.98)).toBe(2998)
    expect(toCents(1.005)).toBe(101)
  })
})

describe('sumMoney', () => {
  // The pair that produced nine identical e-mails in production on 2026-08-23.
  it('soma as pernas do par no valor que o banco guardaria', () => {
    expect(1178.54 + 1188.61).toBe(2367.1499999999996) // o que o JS faz
    expect(sumMoney(1178.54, 1188.61)).toBe(2367.15)   // o que a coluna guarda
  })

  // A parcela com fração de centavo é hipotética aqui — as colunas de tarifa são
  // NUMERIC(10,2) — mas define onde o arredondamento acontece: uma vez, no fim.
  it('resolve os casos clássicos de ponto flutuante', () => {
    expect(sumMoney(0.1, 0.2)).toBe(0.3)
    expect(sumMoney(0.7, 0.1)).toBe(0.8)
    expect(sumMoney(1.005, 2.005)).toBe(3.01)
  })

  it('não acumula erro somando muitas parcelas', () => {
    const dez = Array.from({ length: 10 }, () => 0.1)
    expect(dez.reduce((a, b) => a + b, 0)).not.toBe(1)
    expect(sumMoney(...dez)).toBe(1)

    const cem = Array.from({ length: 100 }, () => 1178.54)
    expect(sumMoney(...cem)).toBe(117854)
  })

  it('aceita nenhuma e uma parcela', () => {
    expect(sumMoney()).toBe(0)
    expect(sumMoney(2367.15)).toBe(2367.15)
  })

  it('bate com o valor lido do banco depois do round-trip em NUMERIC(12,2)', () => {
    const total = sumMoney(1178.54, 1188.61)
    const doBanco = Number('2367.15') // como o pg devolve NUMERIC
    expect(total).toBe(doBanco)
    expect(toCents(total)).toBe(toCents(doBanco))
  })
})

describe('isCheaperBy', () => {
  const MARGEM = 0.01

  // The regression: the same price, one side computed and the other read back
  // from the column, used to pass as an improvement.
  it('preço igual ao do banco não é melhora', () => {
    expect(isCheaperBy(1178.54 + 1188.61, 2367.15, MARGEM)).toBe(false)
    expect(isCheaperBy(sumMoney(1178.54, 1188.61), 2367.15, MARGEM)).toBe(false)
    expect(isCheaperBy(2367.15, 2367.15, MARGEM)).toBe(false)
  })

  it('queda menor que a margem não conta', () => {
    expect(isCheaperBy(2367.14, 2367.15, MARGEM)).toBe(false) // um centavo
    expect(isCheaperBy(2355.00, 2367.15, MARGEM)).toBe(false) // 0,5%
    expect(isCheaperBy(2343.48, 2367.15, MARGEM)).toBe(false) // um centavo acima do limite
  })

  it('queda a partir da margem conta', () => {
    expect(isCheaperBy(2343.47, 2367.15, MARGEM)).toBe(true) // exatamente 1%
    expect(isCheaperBy(2300.00, 2367.15, MARGEM)).toBe(true)
    expect(isCheaperBy(1000.00, 2367.15, MARGEM)).toBe(true)
  })

  it('preço maior nunca conta', () => {
    expect(isCheaperBy(2400.00, 2367.15, MARGEM)).toBe(false)
    expect(isCheaperBy(2367.16, 2367.15, MARGEM)).toBe(false)
  })

  it('sem referência (piso infinito) qualquer preço passa', () => {
    expect(isCheaperBy(9999.99, Infinity, MARGEM)).toBe(true)
    expect(isCheaperBy(0.01, Infinity, MARGEM)).toBe(true)
  })

  it('margem zero ainda exige bater por um centavo', () => {
    expect(isCheaperBy(2367.15, 2367.15, 0)).toBe(false)
    expect(isCheaperBy(2367.14, 2367.15, 0)).toBe(true)
  })

  it('margem maior exige queda maior', () => {
    expect(isCheaperBy(2248.79, 2367.15, 0.05)).toBe(true)  // 5,0%
    expect(isCheaperBy(2250.00, 2367.15, 0.05)).toBe(false) // 4,95%, quase lá
  })

  it('valor não finito não é melhora', () => {
    expect(isCheaperBy(NaN, 2367.15, MARGEM)).toBe(false)
    expect(isCheaperBy(Infinity, 2367.15, MARGEM)).toBe(false)
  })

  it('a margem é sobre a referência, não sobre a diferença', () => {
    // 1% de 100 é 1 real: 99,00 passa, 99,01 não.
    expect(isCheaperBy(99.00, 100.00, MARGEM)).toBe(true)
    expect(isCheaperBy(99.01, 100.00, MARGEM)).toBe(false)
  })
})
