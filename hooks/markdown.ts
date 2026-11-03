/**
 * The pane's Markdown cannot draw pictures, so every image in an issue body or comment becomes a
 * link that opens it in the browser. Code (fenced blocks and inline spans) is left as written.
 */

const LABEL_DEFAULTS = new Set(['', 'image', 'img', 'screenshot', 'untitled'])

/** `↗ image: <name>` from the alt text, else a file name in the URL, else `↗ image`. */
function label(alt: string, src: string): string {
  const clean = alt.replace(/[[\]\\`*_<>]/g, '').replace(/\s+/g, ' ').trim()
  let name = LABEL_DEFAULTS.has(clean.toLowerCase()) ? '' : clean
  if (!name) {
    const last = decodeURIComponentSafe(src.split(/[?#]/)[0].split('/').pop() ?? '')
    if (/\.[a-z0-9]{2,5}$/i.test(last)) name = last.replace(/[[\]\\`*_<>]/g, '')
  }

  return name ? `↗ image: ${name}` : '↗ image'
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const safeUrl = (url: string) => url.replace(/[\s()<>]/g, c => encodeURIComponent(c))
const link = (alt: string, src: string, href = src) => `[${label(alt, src)}](${safeUrl(href)})`

const attr = (tag: string, name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)

  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

// ![alt](src "title") with an optional <src>; the alt may hold one level of brackets
const MD_IMAGE = String.raw`!\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(\s*<?([^\s)>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`
const LINKED_MD_IMAGE = new RegExp(String.raw`\[\s*${MD_IMAGE}\s*\]\(\s*<?([^\s)>]+)>?\s*\)`, 'g')
const BARE_MD_IMAGE = new RegExp(MD_IMAGE, 'g')
const LINKED_HTML_IMAGE = /<a\b[^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi
const HTML_IMAGE = /<img\b[^>]*>/gi
const PICTURE = /<picture\b[^>]*>[\s\S]*?(<img\b[^>]*>)[\s\S]*?<\/picture>/gi

function rewriteProse(text: string): string {
  return text
    .replace(PICTURE, (_, img: string) => img)
    .replace(LINKED_HTML_IMAGE, (whole: string, img: string) => {
      const href = attr(whole, 'href')
      const src = attr(img, 'src')

      return src ? link(attr(img, 'alt'), src, href || src) : whole
    })
    .replace(HTML_IMAGE, (img: string) => {
      const src = attr(img, 'src')

      return src ? link(attr(img, 'alt'), src) : img
    })
    .replace(LINKED_MD_IMAGE, (_, alt: string, src: string, href: string) => link(alt, src, href))
    .replace(BARE_MD_IMAGE, (_, alt: string, src: string) => link(alt, src))
}

/** Rewrites a prose run, leaving its inline code spans as written. */
function rewriteOutsideSpans(text: string): string {
  // split with two groups yields [prose, ticks, code, prose, ticks, code, ..., prose]
  const parts = text.split(/(`+)([\s\S]*?[^`])\1(?!`)/)
  let out = ''
  for (let i = 0; i < parts.length; i += 3) {
    out += rewriteProse(parts[i])
    if (i + 2 < parts.length) out += parts[i + 1] + parts[i + 2] + parts[i + 1]
  }

  return out
}

/** Replaces every image in GitHub Markdown with a link to it, leaving code untouched. */
export function imagesToLinks(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let prose: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (prose.length) out.push(rewriteOutsideSpans(prose.join('\n')))
    prose = []
  }
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      out.push(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) {
        fence = null
      }
    } else if (m) {
      flush()
      fence = m[1]
      out.push(line)
    } else {
      prose.push(line)
    }
  }
  flush()

  return out.join('\n')
}
