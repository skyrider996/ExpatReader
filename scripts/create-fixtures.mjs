import { zipSync, strToU8 } from 'fflate'
import { mkdirSync, writeFileSync } from 'node:fs'

// Original text written for these tests; CC0. No downloaded or personal books.
mkdirSync('tests/fixtures', { recursive: true })
function book(name, chapters, lang = 'en') {
  const xml = s => strToU8(s)
  const files = {
    mimetype: [xml('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': xml('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'EPUB/book.opf': xml(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${name}</dc:identifier><dc:title>${name}</dc:title><dc:language>${lang}</dc:language><dc:creator>Reader test team</dc:creator><meta property="dcterms:modified">2026-10-18T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="s${i}" href="s${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="s${i}"/>`).join('')}</spine></package>`),
    'EPUB/nav.xhtml': xml(`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map((_, i) => `<li><a href="s${i}.xhtml">Chapter ${i + 1}</a></li>`).join('')}</ol></nav></body></html>`),
  }
  chapters.forEach((html, i) => { files[`EPUB/s${i}.xhtml`] = xml(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i + 1}</title></head><body>${html}</body></html>`) })
  writeFileSync(`tests/fixtures/${name}.epub`, zipSync(files))
}
book('A-small-journey', [
  '<h1>A small journey</h1><p>She <em>reluctantly</em> agreed to the <strong>proposal</strong>.</p><p>The garden was quiet.</p><p>The garden was quiet.</p><ul><li>First idea<ul><li>A nested discovery.</li></ul></li></ul><p>Each small question opened a new door.</p>' + Array.from({ length: 25 }, (_, i) => `<p>On day ${i + 1}, Mira read slowly and noticed a different detail in the garden. She kept a short note beside the passage.</p>`).join(''),
  '<h1>The proposal</h1><p>The proposal was to build a public garden together.</p><p>Mira changed her mind after meeting the neighbours.</p><p>书籍检索应该支持中文词语，也应准确定位原文。</p>',
])
book('另一种结构', [
  '<h1>观察手记</h1><div>阅读是一种缓慢的发现。<span>重要的是保留语境。</span></div><blockquote><p>一次只帮助读者理解一个障碍。</p></blockquote><ol><li>第一条记录</li><li><p>第二条记录</p></li></ol>',
  '<h2>第二章</h2><p>相同的词，在不同的语境里可能有不同的含义。</p>',
], 'zh')
book('script-test', ['<h1>Security fixture</h1><script>parent.document.documentElement.dataset.bookScript="executed"</script><p onclick="parent.document.documentElement.dataset.bookEvent=\'executed\'">Click should not execute book code.</p>'])
console.log('Created 3 CC0 EPUB fixtures.')
