"""Bulk-import product photos from a folder via the monofarm API.

File naming convention: {SKU}_{any_suffix}.jpeg|jpg|png|webp
The SKU is everything before the LAST underscore in the filename stem.

Usage:
    python scripts/import_product_images.py /path/to/photos --token <JWT>

    --only-missing      skip products that already have a photo
    --replace-existing  upload new photo and DELETE all old photos (per product)
    --dry-run           print plan without sending anything
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
    resp = requests.get(f"{api}/api/warehouse/products", headers=headers, timeout=30)
    resp.raise_for_status()
    return {p["sku"]: p for p in resp.json()}


def list_images(api: str, headers: dict, product_id: int) -> list[dict]:
    resp = requests.get(f"{api}/api/warehouse/products/{product_id}/images",
                        headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()


def upload_image(api: str, headers: dict, product_id: int, path: Path) -> None:
    mime = _EXT_MIME[path.suffix.lower()]
    with path.open("rb") as f:
        resp = requests.post(
            f"{api}/api/warehouse/products/{product_id}/images",
            headers=headers,
            files={"file": (path.name, f, mime)},
            timeout=120,
        )
    resp.raise_for_status()


def delete_image(api: str, headers: dict, product_id: int, image_id: int) -> None:
    resp = requests.delete(
        f"{api}/api/warehouse/products/{product_id}/images/{image_id}",
        headers=headers, timeout=15,
    )
    resp.raise_for_status()


def main(folder: str, api: str, token: str,
         dry_run: bool = False,
         only_missing: bool = False,
         replace_existing: bool = False,
         skip_skus_file: str | None = None) -> None:
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

    # when replacing: process each SKU only once (first file wins)
    seen_skus: set[str] = set()
    if skip_skus_file:
        seen_skus = {l.strip() for l in open(skip_skus_file) if l.strip()}
        print(f"Resuming — skipping {len(seen_skus)} already done SKUs\n")

    ok = skipped = deleted = errors = 0
    for path in photos:
        sku = path.stem.rsplit("_", 1)[0]
        product = products.get(sku)

        if not product:
            print(f"  SKIP   {path.name}  — SKU '{sku}' not found")
            skipped += 1
            continue

        pid = product["id"]

        if only_missing and product.get("image_url"):
            if sku not in seen_skus:
                print(f"  HAS    {path.name}  — {product['name']} вже має фото")
                seen_skus.add(sku)
            skipped += 1
            continue

        if replace_existing and sku in seen_skus:
            # already processed this product — skip extra files from same SKU
            skipped += 1
            continue

        tag = "DRY  " if dry_run else "REPLACE" if replace_existing else "UPLOAD"
        print(f"  {tag}  {path.name}  →  {product['name']} (id={pid})")

        if dry_run:
            ok += 1
            seen_skus.add(sku)
            continue

        try:
            if replace_existing:
                old_images = list_images(api, headers, pid)
                upload_image(api, headers, pid, path)
                for img in old_images:
                    delete_image(api, headers, pid, img["id"])
                    deleted += 1
                    print(f"    DEL  image_id={img['id']}")
            else:
                upload_image(api, headers, pid, path)

            ok += 1
            seen_skus.add(sku)
            time.sleep(0.1)
        except Exception as e:
            print(f"    ERROR: {e}")
            errors += 1

    print(f"\nDone: {ok} uploaded, {deleted} old deleted, {skipped} skipped, {errors} errors")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("folder", help="folder with photos")
    p.add_argument("--api",   default="https://api.monofarm.app", help="API base URL")
    p.add_argument("--token", required=True, help="JWT or API key")
    p.add_argument("--dry-run",          action="store_true")
    p.add_argument("--only-missing",     action="store_true", help="skip if already has a photo")
    p.add_argument("--replace-existing", action="store_true", help="upload new + delete all old photos")
    p.add_argument("--skip-skus-file", help="file with already-done SKUs (one per line) for resume")
    args = p.parse_args()

    main(args.folder, api=args.api, token=args.token,
         dry_run=args.dry_run,
         only_missing=args.only_missing,
         replace_existing=args.replace_existing,
         skip_skus_file=args.skip_skus_file)
