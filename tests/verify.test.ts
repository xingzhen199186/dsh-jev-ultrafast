import { describe, expect, it } from 'vitest'
import { verify } from '../src/verify'

/**
 * The check that stands between "the model said it worked" and "it worked". These tests pin
 * the wording too, because that sentence is what a reader is left with.
 */

const page = ['Flights from Zürich', 'Order confirmed', 'Reference AB-1234'].join('\n')

describe('verifying a claim against the page', () => {
  it('passes when every asked-for string is there, and shows where', () => {
    const result = verify(page, ['Order confirmed', 'AB-1234'])

    expect(result.checked).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.note).toBe('核验通过：2 项都在最终页面上找到了')
    expect(result.items[0]).toMatchObject({ kind: 'must', found: true, passed: true, where: 'Order confirmed' })
  })

  it('fails and names what is missing', () => {
    const result = verify(page, ['Order confirmed', 'Payment received'])

    expect(result.passed).toBe(false)
    expect(result.note).toBe('核验未通过：没找到「Payment received」')
    expect(result.items[1]).toMatchObject({ found: false, passed: false, where: '没有找到' })
  })

  it('treats a leading ! as "this must not be on the page"', () => {
    const clean = verify(page, ['!No results', 'Order confirmed'])
    expect(clean.passed).toBe(true)

    const dirty = verify(`${page}\nNo results found`, ['!No results'])
    expect(dirty.passed).toBe(false)
    expect(dirty.note).toBe('核验未通过：出现了不该出现的「!No results」')
    expect(dirty.items[0]).toMatchObject({ kind: 'mustNot', found: true, passed: false })
  })

  it('ignores case and how the page breaks a line', () => {
    expect(verify('ORDER\nCONFIRMED', ['order confirmed']).passed).toBe(true)
    expect(verify('Zürich   to   Bern', ['zürich to bern']).passed).toBe(true)
  })

  it('says plainly that nothing was checked when no items were given', () => {
    const result = verify(page, undefined)

    expect(result.checked).toBe(false)
    expect(result.passed).toBe(true)
    expect(result.note).toContain('未经核实')
    expect(verify(page, ['  ', '']).checked).toBe(false)
  })

  it('does not call a page successful just because it could not be read', () => {
    const result = verify('', ['Order confirmed'])

    expect(result.passed).toBe(false)
    expect(result.note).toContain('没找到')
  })
})
