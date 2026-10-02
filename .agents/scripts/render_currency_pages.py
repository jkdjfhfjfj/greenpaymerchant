from pathlib import Path

import fitz


SOURCE = Path(
    "attached_assets/API_Documentation___Payzaapi_for_developers-1790749720994_1790919482974.pdf"
)
OUTPUT_DIR = Path(".agents/outputs")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

with fitz.open(SOURCE) as document:
    selected_pages: set[int] = set()
    for index, page in enumerate(document):
        text = page.get_text()
        if "Currencies and methods" in text:
            selected_pages.update((index, min(index + 1, document.page_count - 1)))
        if "Payout methods" in text:
            selected_pages.add(index)

    print(f"PDF pages: {document.page_count}")
    for index in sorted(selected_pages):
        image_path = OUTPUT_DIR / f"payzaapi-reference-page-{index + 1}.png"
        document.load_page(index).get_pixmap(
            matrix=fitz.Matrix(2, 2),
            alpha=False,
        ).save(image_path)
        print(image_path)