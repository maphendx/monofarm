"""Bulk-import product photos from a folder via the monofarm API.

File naming convention: {SKU}_{any_suffix}.jpeg|jpg|png|webp
The SKU is everything before the LAST underscore in the filename stem.

Usage:
    python scripts/import_product_images.py /path/to/photos \\
        --api https://api.monofarm.app \\
        --token <JWT or API key>

    # dry-run — show what would be uploaded without sending anything
    python scripts/import_product_images.py /path/to/photos \\
        --api https://api.monofarm.app --token <...> --dry-run
"""

import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("pip install requests"); sys.exit(1)

_EXT_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".png": "image/png",  ".webp": "image/webp"}


def load_products(api: str, headers: dict) -> dict[str, dict]:
    """Return {sku: {id, name}} for all products."""
    resp = requests.get(f"{api}/api/warehouse/products", headers=headers, timeout=30)
    resp.raise_for_status()
    return {p["sku"]: p for p in resp.json()}


def upload_image(api: str, headers: dict, product_id: int, path: Path) -> None:
    mime = _EXT_MIME[path.suffix.lower()]
    with path.open("rb") as f:
        resp = requests.post(
            f"{api}/api/warehouse/products/{product_id}/images",
            headers=headers,
            files={"file": (path.name, f, mime)},
            timeout=60,
        )
    resp.raise_for_status()


def main(folder: str, api: str, token: str, dry_run: bool = False) -> None:
    api = api.rstrip("/")
    headers = {"Authorization": f"Bearer {token}"}

    photos = sorted(
        p for p in Path(folder).iterdir()
        if p.suffix.lower() in _EXT_MIME
    )
    if not photos:
        print(f"No images found in {folder}"); return

    print(f"Loading products from {api}…")
    products = load_products(api, headers)
    print(f"Found {len(products)} products in catalogue\n")

    ok = skipped = errors = 0
    for path in photos:
        sku = path.stem.rsplit("_", 1)[0]
        product = products.get(sku)

        if not product:
            print(f"  SKIP   {path.name}  — SKU '{sku}' not found")
            skipped += 1
            continue

        tag = "DRY  " if dry_run else "UPLOAD"
        print(f"  {tag}  {path.name}  →  {product['name']} (id={product['id']})")

        if dry_run:
            ok += 1
            continue

        try:
            upload_image(api, headers, product["id"], path)
            ok += 1
            time.sleep(0.1)          # be gentle with the API
        except Exception as e:
            print(f"    ERROR: {e}")
            errors += 1

    print(f"\nDone: {ok} uploaded, {skipped} skipped (SKU not found), {errors} errors")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("folder", help="folder with photos")
    p.add_argument("--api",   default="https://api.monofarm.app", help="API base URL")
    p.add_argument("--token", required=True, help="JWT or API key")
    p.add_argument("--dry-run", action="store_true", help="print plan without uploading")
    args = p.parse_args()

    main(args.folder, api=args.api, token=args.token, dry_run=args.dry_run)
