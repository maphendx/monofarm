"""Standalone filament label generator.

Generates QR-enriched label data and multi-template PDFs for spool labels.
Can be reused in any FastAPI app that provides Filament model + get_current_org dep.
"""

import base64
import io
import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_org
from app.core.db import get_db
from app.models.filament import Filament
from app.models.organization import Organization

router = APIRouter(prefix="/filaments", tags=["filament-labels"])

GRAMS_TOTAL = 1000


# ── schemas ───────────────────────────────────────────────────────────────────

class LabelDataOut(BaseModel):
    id: int
    sku: str | None
    brand: str | None
    material: str
    color: str
    hex_color: str | None
    grams_remaining: int
    grams_total: int
    pct_remaining: int
    cost_per_kg: int | None
    note: str | None
    qr_code_base64: str | None


class LabelPdfRequest(BaseModel):
    filament_ids: list[int]
    template: Literal["standard", "compact", "thermal_62mm", "custom"] = "standard"
    custom_w_mm: float | None = None
    custom_h_mm: float | None = None
    show_qr: bool = True
    show_color: bool = True
    show_brand: bool = True
    show_sku: bool = True
    show_progress: bool = True


# ── QR helper ─────────────────────────────────────────────────────────────────

def _make_qr_base64(data: str) -> str | None:
    try:
        import qrcode
        qr = qrcode.QRCode(box_size=4, border=2,
                           error_correction=qrcode.constants.ERROR_CORRECT_M)
        qr.add_data(data)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{filament_id}/label-data", response_model=LabelDataOut)
def get_label_data(
    filament_id: int,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
) -> LabelDataOut:
    f = db.query(Filament).filter(
        Filament.id == filament_id, Filament.organization_id == org.id
    ).first()
    if not f:
        raise HTTPException(status_code=404, detail="Filament not found")

    frontend_url = os.getenv("FARM_PUBLIC_URL", "http://localhost:3000")
    qr_url = f"{frontend_url}/filament?scan={f.sku}" if f.sku else None

    return LabelDataOut(
        id=f.id,
        sku=f.sku,
        brand=f.brand,
        material=f.material,
        color=f.color,
        hex_color=f.hex_color,
        grams_remaining=f.grams_remaining,
        grams_total=GRAMS_TOTAL,
        pct_remaining=min(100, round((f.grams_remaining / GRAMS_TOTAL) * 100)),
        cost_per_kg=f.cost_per_kg,
        note=f.note,
        qr_code_base64=_make_qr_base64(qr_url) if qr_url else None,
    )


@router.post("/labels/pdf")
def generate_labels_pdf(
    payload: LabelPdfRequest,
    db: Session = Depends(get_db),
    org: Organization = Depends(get_current_org),
):
    filaments = (
        db.query(Filament)
        .filter(Filament.id.in_(payload.filament_ids), Filament.organization_id == org.id)
        .all()
    )
    if not filaments:
        raise HTTPException(status_code=404, detail="No filaments found")

    try:
        pdf_bytes = _build_pdf(
            filaments, payload.template,
            custom_w_mm=payload.custom_w_mm,
            custom_h_mm=payload.custom_h_mm,
            show_qr=payload.show_qr,
            show_color=payload.show_color,
            show_brand=payload.show_brand,
            show_sku=payload.show_sku,
            show_progress=payload.show_progress,
        )
    except ImportError:
        raise HTTPException(status_code=500, detail="reportlab not installed")

    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=filament-labels.pdf"},
    )


# ── PDF generation ────────────────────────────────────────────────────────────

_TEMPLATES: dict[str, dict] = {
    "standard":     {"w_mm": 85,  "h_mm": 54, "cols": 2, "rows": 5},
    "compact":      {"w_mm": 40,  "h_mm": 20, "cols": 5, "rows": 14},
    "thermal_62mm": {"w_mm": 62,  "h_mm": 29, "cols": 3, "rows": 9},
    "custom":       {"w_mm": 85,  "h_mm": 54, "cols": 2, "rows": 5},  # overridden at runtime
}


def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    h = hex_color.lstrip("#")
    if len(h) == 6:
        return int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255
    return 0.5, 0.5, 0.5


def _build_pdf(
    filaments: list[Filament],
    template: str,
    *,
    custom_w_mm: float | None = None,
    custom_h_mm: float | None = None,
    show_qr: bool = True,
    show_color: bool = True,
    show_brand: bool = True,
    show_sku: bool = True,
    show_progress: bool = True,
) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl_canvas

    tmpl = dict(_TEMPLATES.get(template, _TEMPLATES["standard"]))
    if template == "custom":
        tmpl["w_mm"] = custom_w_mm or 85
        tmpl["h_mm"] = custom_h_mm or 54
        # auto-compute cols/rows from A4 with 5mm margins each side
        page_w_mm, page_h_mm = 210, 297
        tmpl["cols"] = max(1, int((page_w_mm - 10) / tmpl["w_mm"]))
        tmpl["rows"] = max(1, int((page_h_mm - 10) / tmpl["h_mm"]))

    lw = tmpl["w_mm"] * mm
    lh = tmpl["h_mm"] * mm
    cols = tmpl["cols"]
    rows = tmpl["rows"]

    page_w, page_h = A4
    margin_x = (page_w - cols * lw) / 2
    margin_y = (page_h - rows * lh) / 2

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=A4)

    fields = dict(qr=show_qr, color=show_color, brand=show_brand, sku=show_sku, progress=show_progress)

    for i, f in enumerate(filaments):
        col = i % cols
        row = (i // cols) % rows
        if i > 0 and col == 0 and row == 0:
            c.showPage()
        x = margin_x + col * lw
        y = page_h - margin_y - (row + 1) * lh
        _draw_label(c, f, x, y, lw, lh, template, mm, fields)

    c.save()
    return buf.getvalue()


def _draw_label(c, f: Filament, x, y, w, h, template: str, mm, fields: dict | None = None) -> None:
    if fields is None:
        fields = dict(qr=True, color=True, brand=True, sku=True, progress=True)
    from reportlab.graphics.barcode import qr as rl_qr
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF

    pct = min(100, round((f.grams_remaining / GRAMS_TOTAL) * 100))

    # border
    c.setStrokeColorRGB(0.85, 0.85, 0.85)
    c.setLineWidth(0.4)
    c.rect(x, y, w, h)

    if template == "compact":
        sw = 5 * mm
        if f.hex_color and fields["color"]:
            r, g, b = _hex_to_rgb(f.hex_color)
            c.setFillColorRGB(r, g, b)
            c.rect(x, y, sw, h, fill=1, stroke=0)
        tx = x + sw + 1 * mm
        c.setFillColorRGB(0, 0, 0)
        if fields["color"]:
            c.setFont("Helvetica-Bold", 5.5)
            c.drawString(tx, y + h - 5 * mm, f.color[:14])
        if fields["brand"]:
            c.setFont("Helvetica", 4.5)
            c.drawString(tx, y + h - 9.5 * mm, f.material)
        if fields["progress"]:
            c.setFont("Helvetica", 4)
            c.drawString(tx, y + h - 13.5 * mm, f"{pct}% · {f.grams_remaining}g")
        if fields["sku"] and f.sku:
            c.setFont("Courier", 4)
            c.setFillColorRGB(0.55, 0.55, 0.55)
            c.drawString(tx, y + 2 * mm, f.sku)
        return

    show_qr = fields["qr"]
    qr_size = h * (0.8 if template == "thermal_62mm" else 0.72) if show_qr else 0
    qr_x = x + 1.5 * mm

    if show_qr:
        qr_y = y + (h - qr_size) / 2
        frontend_url = os.getenv("FARM_PUBLIC_URL", "http://localhost:3000")
        qr_data = f"{frontend_url}/filament?scan={f.sku}" if f.sku else f"FL#{f.id}"
        try:
            d = Drawing(qr_size, qr_size)
            qrc = rl_qr.QrCodeWidget(qr_data)
            qrc.barWidth = qr_size
            qrc.barHeight = qr_size
            d.add(qrc)
            renderPDF.draw(d, c, qr_x, qr_y)
        except Exception:
            pass

    tx = x + (qr_size + 3 * mm if show_qr else 2 * mm)
    tw = w - (tx - x) - 2 * mm
    is_std = template in ("standard", "custom")

    # color swatch + name
    if fields["color"]:
        if f.hex_color:
            r, g, b = _hex_to_rgb(f.hex_color)
            c.setFillColorRGB(r, g, b)
            sw = 4.5 * mm
            c.roundRect(tx, y + h - sw - 2 * mm, sw, sw, 0.8 * mm, fill=1, stroke=0)
        swatch_offset = 5.5 * mm if f.hex_color else 0
        c.setFillColorRGB(0, 0, 0)
        c.setFont("Helvetica-Bold", 9 if is_std else 7)
        c.drawString(tx + swatch_offset, y + h - (8 if is_std else 7) * mm, f.color[:18])

    # brand · material
    if fields["brand"]:
        c.setFont("Helvetica", 6.5 if is_std else 5.5)
        c.setFillColorRGB(0.35, 0.35, 0.35)
        brand_mat = " · ".join(p for p in [f.brand, f.material] if p)
        c.drawString(tx, y + h - (14 if is_std else 13) * mm, brand_mat[:24])

    # SKU
    if fields["sku"] and f.sku:
        c.setFont("Courier", 6 if is_std else 5)
        c.setFillColorRGB(0.55, 0.55, 0.55)
        c.drawString(tx, y + 7 * mm, f.sku)

    # progress bar
    if fields["progress"]:
        bar_y = y + 2 * mm
        bar_w = tw
        bar_h = 2.5 * mm
        c.setFillColorRGB(0.9, 0.9, 0.9)
        c.roundRect(tx, bar_y, bar_w, bar_h, 1 * mm, fill=1, stroke=0)
        if pct > 0:
            if pct < 20:
                c.setFillColorRGB(0.95, 0.5, 0.2)
            elif pct < 40:
                c.setFillColorRGB(0.95, 0.75, 0.1)
            else:
                c.setFillColorRGB(0.23, 0.51, 0.96)
            c.roundRect(tx, bar_y, bar_w * pct / 100, bar_h, 1 * mm, fill=1, stroke=0)
        c.setFont("Helvetica", 5.5 if is_std else 5)
        c.setFillColorRGB(0.4, 0.4, 0.4)
        c.drawString(tx, bar_y + bar_h + 0.8 * mm, f"{pct}% · {f.grams_remaining} / {GRAMS_TOTAL}g")
