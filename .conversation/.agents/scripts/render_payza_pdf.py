import fitz
from pathlib import Path
src = Path('attached_assets/API_Documentation___Payzaapi_for_developers_1790746396691.pdf')
out = Path('.agents/outputs')
doc = fitz.open(src)
for i, page in enumerate(doc):
    pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
    path = out / f'payza-page-{i+1}.png'
    pix.save(path)
print(f'Rendered {len(doc)} pages to {out}')
