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
import gzip, base64
sample = (pathlib.Path(__file__).parent / 'samples' / 'SAMPLE-X.dxf').read_bytes()
page = page.replace('{{SAMPLE}}', base64.b64encode(gzip.compress(sample, 9, mtime=0)).decode())
(pathlib.Path(__file__).parent / 'index.html').write_text(page)
print('index.html', len(page), 'bytes, build', build)
