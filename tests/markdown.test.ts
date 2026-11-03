import { expect, test } from 'claude-code/testing'

import { imagesToLinks } from '../hooks/markdown'

const ASSET = 'https://github.com/user-attachments/assets/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'

test('a Markdown image becomes a link named by its alt text', () => {
  expect(imagesToLinks('See ![crash dialog](https://example.com/a.png "Crash") here.')).toBe(
    'See [↗ image: crash dialog](https://example.com/a.png) here.',
  )
})

test('a default alt falls back to the file name, else to "image"', () => {
  expect(imagesToLinks('![image](https://example.com/shots/screen%201.png)')).toBe(
    '[↗ image: screen 1.png](https://example.com/shots/screen%201.png)',
  )
  expect(imagesToLinks(`![Image](${ASSET})`)).toBe(`[↗ image](${ASSET})`)
})

test('an HTML img, as GitHub inserts uploads, becomes a link', () => {
  expect(imagesToLinks(`<img width="640" alt="Image" src="${ASSET}" />`)).toBe(`[↗ image](${ASSET})`)
  expect(imagesToLinks(`<a href="https://example.com/full"><img src="${ASSET}" alt="graph"></a>`)).toBe(
    '[↗ image: graph](https://example.com/full)',
  )
})

test('a linked Markdown image keeps the outer link target', () => {
  expect(imagesToLinks('[![badge](https://img.shields.io/x.svg)](https://ci.example.com)')).toBe(
    '[↗ image: badge](https://ci.example.com)',
  )
})

test('code is left as written', () => {
  const body = ['Inline `![x](a.png)` stays.', '```md', '![y](b.png)', '```', '![z](c.png)'].join('\n')
  expect(imagesToLinks(body)).toBe(
    ['Inline `![x](a.png)` stays.', '```md', '![y](b.png)', '```', '[↗ image: z](c.png)'].join('\n'),
  )
})

test('text without images is unchanged', () => {
  const body = 'Steps:\n1. open [the docs](https://example.com)\n2. press `!`'
  expect(imagesToLinks(body)).toBe(body)
})
