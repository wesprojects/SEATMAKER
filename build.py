"""Assemble index.html from src/. Usage: python3 build.py YYYY-MM-DD.N"""
import sys, re, pathlib
build = sys.argv[1] if len(sys.argv) > 1 else ''
if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.\d+', build):
    sys.exit('Give the build number as YYYY-MM-DD.N, dated today.')
src = pathlib.Path(__file__).parent / 'src'
page = (src / 'page.html').read_text()
page = page.replace('{{BRAND}}', (src / 'brand.html').read_text().rstrip('\n'))
page = page.replace('{{ENGINE}}', (src / 'engine.js').read_text().replace("if (typeof module !== 'undefined') module.exports = SM;", ''))
page = page.replace('{{BUILD}}', build)
(pathlib.Path(__file__).parent / 'index.html').write_text(page)
print('index.html', len(page), 'bytes, build', build)
