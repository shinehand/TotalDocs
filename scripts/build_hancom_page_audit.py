#!/usr/bin/env python3

import argparse
import html
import json
from pathlib import Path
from statistics import median

from PIL import Image, ImageChops, ImageDraw, ImageStat


PAGE_RATIO = 1.414
PAGE_RATIO_TOLERANCE = 0.10
PAGE_MIN_WIDTH_RATIO = 0.20


def longest_true_run(values):
    best_start = 0
    best_end = -1
    best_len = 0
    start = None

    for index, value in enumerate(values):
        if value and start is None:
            start = index
        is_last = index == len(values) - 1
        if start is not None and ((not value) or is_last):
            end = index if value and is_last else index - 1
            length = end - start + 1
            if length > best_len:
                best_start = start
                best_end = end
                best_len = length
            start = None

    return best_start, best_end, best_len


def detect_page_bands(image):
    width, height = image.size
    pixels = image.load()
    min_y = max(35, height // 18)
    rows = []

    for y in range(min_y, max(min_y, height - 20)):
        is_page = []
        for x in range(width):
            red, green, blue = pixels[x, y][:3]
            is_page.append(red >= 242 and green >= 242 and blue >= 238)
        left, right, run_width = longest_true_run(is_page)
        if width * PAGE_MIN_WIDTH_RATIO <= run_width <= width * 0.94:
            rows.append((y, left, right, run_width))

    if not rows:
        raise RuntimeError("Could not detect page band")

    clusters = []
    current = [rows[0]]
    for row in rows[1:]:
        if row[0] - current[-1][0] <= 6:
            current.append(row)
        else:
            clusters.append(current)
            current = [row]
    clusters.append(current)

    max_run = max(row[3] for row in rows)
    candidates = []
    for candidate in clusters:
        span = candidate[-1][0] - candidate[0][0]
        avg_run = sum(row[3] for row in candidate) / len(candidate)
        if span >= 8 and avg_run >= max_run * 0.72:
            candidates.append(candidate)
    if not candidates:
        candidates = [sorted(
            clusters,
            key=lambda candidate: (
                sum(row[3] for row in candidate) / len(candidate),
                candidate[-1][0] - candidate[0][0],
            ),
            reverse=True,
        )[0]]

    bands = []
    for cluster in sorted(candidates, key=lambda item: item[0][0]):
        wide_rows = [row for row in cluster if row[3] >= max_run * 0.72] or cluster
        left = int(median(row[1] for row in wide_rows))
        right = int(median(row[2] for row in wide_rows))
        top = min(row[0] for row in cluster)
        bottom = max(row[0] for row in cluster)
        page_width = right - left + 1
        if page_width >= image.width * PAGE_MIN_WIDTH_RATIO:
            bands.append((left, top, right, bottom))

    if not bands:
        raise RuntimeError("Could not detect page band")
    return bands


def detect_page_rects(image):
    scale = 2
    small = image.resize((max(1, image.width // scale), max(1, image.height // scale)), Image.Resampling.NEAREST)
    width, height = small.size
    pixels = small.load()
    min_y = max(70, height // 8)
    visited = bytearray(width * height)

    def is_page_pixel(x, y):
        if y < min_y:
            return False
        red, green, blue = pixels[x, y][:3]
        return red >= 235 and green >= 235 and blue >= 232

    rects = []
    for y in range(min_y, height):
        row_offset = y * width
        for x in range(width):
            index = row_offset + x
            if visited[index] or not is_page_pixel(x, y):
                continue

            stack = [(x, y)]
            visited[index] = 1
            min_x = max_x = x
            min_comp_y = max_comp_y = y
            area = 0

            while stack:
                cx, cy = stack.pop()
                area += 1
                if cx < min_x:
                    min_x = cx
                if cx > max_x:
                    max_x = cx
                if cy < min_comp_y:
                    min_comp_y = cy
                if cy > max_comp_y:
                    max_comp_y = cy

                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if nx < 0 or nx >= width or ny < min_y or ny >= height:
                        continue
                    nindex = ny * width + nx
                    if visited[nindex] or not is_page_pixel(nx, ny):
                        continue
                    visited[nindex] = 1
                    stack.append((nx, ny))

            comp_w = max_x - min_x + 1
            comp_h = max_comp_y - min_comp_y + 1
            fill = area / max(1, comp_w * comp_h)
            if (
                comp_w >= width * PAGE_MIN_WIDTH_RATIO
                and comp_w <= width * 0.82
                and comp_h >= comp_w * 0.70
                and fill >= 0.32
            ):
                rects.append((
                    min_x * scale,
                    min_comp_y * scale,
                    min((max_x + 1) * scale, image.width) - 1,
                    min((max_comp_y + 1) * scale, image.height) - 1,
                ))

    if rects:
        rects.sort(key=lambda rect: (rect[1], rect[0]))
        return rects

    return detect_page_bands(image)


def crop_hancom_page(image, target_band):
    bands = detect_page_rects(image)
    # At 50% zoom Hancom can show two pages. The capture manifest tells us
    # whether the target is the first visible page or the final visible page.
    if target_band == "last":
        left, top, right, detected_bottom = bands[-1]
    else:
        first = bands[0]
        first_width = first[2] - first[0] + 1
        first_expected_height = int(first_width * 1.414)
        first_height = first[3] - first[1] + 1
        if first_height >= first_expected_height * 0.65:
            left, top, right, detected_bottom = first
        else:
            left, top, right, detected_bottom = max(
                bands,
                key=lambda rect: (rect[3] - rect[1], -rect[1]),
            )
    page_width = right - left + 1
    expected_height = int(page_width * 1.414)
    detected_height = detected_bottom - top + 1
    if detected_height < expected_height * 0.75:
        bottom = min(image.height, detected_bottom + 1)
    else:
        bottom = min(image.height, top + expected_height)
    if bottom <= top + 120:
        bottom = image.height
    return trim_hancom_page_shadow(image.crop((left, top, right + 1, bottom)))


def trim_hancom_page_shadow(image):
    width, height = image.size
    pixels = image.load()

    def column_score(x):
        count = 0
        for y in range(height):
            red, green, blue = pixels[x, y][:3]
            if red >= 235 and green >= 235 and blue >= 232:
                count += 1
        return count / max(1, height)

    def row_score(y):
        count = 0
        for x in range(width):
            red, green, blue = pixels[x, y][:3]
            if red >= 235 and green >= 235 and blue >= 232:
                count += 1
        return count / max(1, width)

    left = 0
    while left < width - 1 and column_score(left) < 0.55:
        left += 1
    right = width - 1
    while right > left and column_score(right) < 0.55:
        right -= 1
    top = 0
    while top < height - 1 and row_score(top) < 0.55:
        top += 1
    bottom = height - 1
    while bottom > top and row_score(bottom) < 0.55:
        bottom -= 1

    if right - left < width * 0.65 or bottom - top < height * 0.65:
        return remove_bottom_dark_band(image)
    return remove_bottom_dark_band(image.crop((left, top, right + 1, bottom + 1)))


def remove_bottom_dark_band(image):
    width, height = image.size
    pixels = image.load()
    cut_y = height
    dark_run = 0

    for y in range(height - 1, max(-1, height - 90), -1):
        dark = 0
        for x in range(width):
            red, green, blue = pixels[x, y][:3]
            if red < 80 and green < 80 and blue < 80:
                dark += 1
        if dark >= width * 0.35:
            dark_run += 1
            cut_y = y
        elif dark_run >= 3:
            break
        else:
            dark_run = 0
            cut_y = height

    if dark_run >= 3 and cut_y > height * 0.78:
        return image.crop((0, 0, width, cut_y))
    return image


def resize_to_width(image, target_width):
    if image.width == target_width:
        return image
    target_height = max(1, round(image.height * (target_width / image.width)))
    return image.resize((target_width, target_height), Image.Resampling.LANCZOS)


def normalized_diff_score(left_image, right_image):
    width = min(left_image.width, right_image.width)
    height = min(left_image.height, right_image.height)
    if width <= 0 or height <= 0:
        return None
    left = left_image.crop((0, 0, width, height)).convert("L")
    right = right_image.crop((0, 0, width, height)).convert("L")
    diff = ImageChops.difference(left, right)
    return ImageStat.Stat(diff).mean[0]


def capture_quality(hancom_page, chrome_page):
    hancom_ratio = hancom_page.height / max(1, hancom_page.width)
    chrome_ratio = chrome_page.height / max(1, chrome_page.width)
    ratio_gap = abs(hancom_ratio - chrome_ratio)
    expected_gap = abs(hancom_ratio - PAGE_RATIO)
    is_suspicious = (
        expected_gap > PAGE_RATIO_TOLERANCE
        or ratio_gap > PAGE_RATIO_TOLERANCE
    )
    return {
        "hancomRatio": hancom_ratio,
        "chromeRatio": chrome_ratio,
        "ratioGap": ratio_gap,
        "expectedGap": expected_gap,
        "status": "capture-review" if is_suspicious else "ok",
    }


def verdict_for_score(score, quality=None):
    if quality and quality.get("status") != "ok":
        return quality["status"]
    if score is None:
        return "capture-error"
    if score <= 18:
        return "close"
    if score <= 32:
        return "review"
    return "mismatch"


def make_compare_image(hancom_page, chrome_page, output_path, title, target_width):
    hancom_norm = resize_to_width(hancom_page, target_width)
    chrome_norm = resize_to_width(chrome_page, target_width)
    gap = 22
    label_h = 42
    pad = 16
    height = max(hancom_norm.height, chrome_norm.height) + label_h + pad * 2
    width = target_width * 2 + gap + pad * 2
    canvas = Image.new("RGB", (width, height), (240, 237, 231))
    draw = ImageDraw.Draw(canvas)
    draw.text((pad, 12), f"Hancom Viewer - {title}", fill=(72, 44, 28))
    chrome_x = pad + target_width + gap
    draw.text((chrome_x, 12), "TotalDocs", fill=(30, 58, 90))
    top = label_h + pad
    canvas.paste(hancom_norm.convert("RGB"), (pad, top))
    canvas.paste(chrome_norm.convert("RGB"), (chrome_x, top))
    draw.rectangle((pad - 1, top - 1, pad + target_width, top + hancom_norm.height), outline=(170, 158, 140))
    draw.rectangle((chrome_x - 1, top - 1, chrome_x + target_width, top + chrome_norm.height), outline=(170, 158, 140))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)


def build_report(manifest, output_dir, target_width):
    results = []
    for doc in manifest.get("documents", []):
        doc_results = []
        doc_dir = output_dir / doc["id"]
        compare_dir = doc_dir / "compare"
        for page in doc.get("pages", []):
            page_index = page["pageIndex"]
            title = f"{doc['filename']} p{page_index + 1}"
            item = {
                "pageIndex": page_index,
                "hancomScreenshot": page.get("hancomScreenshot", ""),
                "chromePage": page.get("chromePage", ""),
                "scrollRatio": page.get("scrollRatio"),
                "targetBand": page.get("targetBand", "first"),
            }
            try:
                hancom_raw = Image.open(item["hancomScreenshot"]).convert("RGB")
                chrome_page = Image.open(item["chromePage"]).convert("RGB")
                hancom_page = crop_hancom_page(hancom_raw, item["targetBand"])
                hancom_crop_path = doc_dir / f"hancom-crop-page-{page_index + 1:03d}.png"
                hancom_crop_path.parent.mkdir(parents=True, exist_ok=True)
                hancom_page.save(hancom_crop_path)
                compare_path = compare_dir / f"page-{page_index + 1:03d}-compare.png"
                make_compare_image(hancom_page, chrome_page, compare_path, title, target_width)
                score = normalized_diff_score(
                    resize_to_width(hancom_page, target_width),
                    resize_to_width(chrome_page, target_width),
                )
                quality = capture_quality(hancom_page, chrome_page)
                item.update({
                    "hancomCrop": str(hancom_crop_path),
                    "pageCompare": str(compare_path),
                    "diff": score,
                    "verdict": verdict_for_score(score, quality),
                    "captureQuality": quality,
                    "hancomCropSize": list(hancom_page.size),
                    "chromeSize": list(chrome_page.size),
                })
            except Exception as error:  # noqa: BLE001
                item.update({
                    "diff": None,
                    "verdict": "capture-error",
                    "error": str(error),
                })
            doc_results.append(item)

        counts = {}
        for item in doc_results:
            counts[item["verdict"]] = counts.get(item["verdict"], 0) + 1
        results.append({
            "id": doc["id"],
            "filename": doc["filename"],
            "sourcePath": doc["sourcePath"],
            "pageCount": doc["pageCount"],
            "verdictCounts": counts,
            "pages": doc_results,
        })
    return results


def write_markdown(results, report_path):
    lines = [
        "# Hancom Page Audit",
        "",
        "한컴 Viewer를 기준으로 테스트 문서의 모든 페이지를 페이지 단위로 캡처한 비교 결과입니다.",
        "",
    ]
    for doc in results:
        lines.append(f"## {doc['filename']}")
        lines.append("")
        lines.append(f"- source: `{doc['sourcePath']}`")
        lines.append(f"- pages: {doc['pageCount']}")
        lines.append(f"- verdicts: {doc['verdictCounts']}")
        lines.append("")
        lines.append("| page | verdict | diff | compare |")
        lines.append("| ---: | --- | ---: | --- |")
        for page in doc["pages"]:
            diff = "" if page["diff"] is None else f"{page['diff']:.3f}"
            compare = page.get("pageCompare", "")
            lines.append(
                f"| {page['pageIndex'] + 1} | {page['verdict']} | {diff} | `{compare}` |"
            )
        lines.append("")
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_html(results, html_path):
    cards = []
    for doc in results:
        page_rows = []
        for page in doc["pages"]:
            compare = page.get("pageCompare")
            image = f'<img src="{html.escape(str(Path(compare).relative_to(html_path.parent)))}" alt="page compare">' if compare else ""
            diff = "" if page["diff"] is None else f"{page['diff']:.3f}"
            page_rows.append(f"""
              <section class="page-card {html.escape(page['verdict'])}">
                <h3>{page['pageIndex'] + 1}쪽 · {html.escape(page['verdict'])} · diff {html.escape(diff)}</h3>
                {image}
              </section>
            """)
        cards.append(f"""
          <article class="doc-card">
            <h2>{html.escape(doc['filename'])}</h2>
            <p>{html.escape(doc['sourcePath'])}</p>
            <p>pages {doc['pageCount']} · verdicts {html.escape(str(doc['verdictCounts']))}</p>
            <div class="page-grid">{''.join(page_rows)}</div>
          </article>
        """)

    html_path.write_text(f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hancom Page Audit</title>
  <style>
    body {{ margin: 0; background: #eee8dc; color: #171410; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }}
    main {{ width: min(1800px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 60px; }}
    h1 {{ margin: 0 0 8px; }}
    .doc-card {{ background: #fffaf2; border: 1px solid #d6c9b8; border-radius: 18px; padding: 18px; margin: 20px 0; }}
    .doc-card p {{ color: #665d52; }}
    .page-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 16px; }}
    .page-card {{ background: white; border: 1px solid #d8d0c3; border-radius: 14px; overflow: hidden; }}
    .page-card h3 {{ margin: 0; padding: 10px 12px; font-size: 15px; background: #f7f2eb; }}
    .page-card.mismatch h3 {{ background: #ffe2df; }}
    .page-card.capture-review h3 {{ background: #ffe9c7; }}
    .page-card.review h3 {{ background: #fff1c2; }}
    .page-card.close h3 {{ background: #e8f5df; }}
    img {{ width: 100%; display: block; }}
  </style>
</head>
<body>
<main>
  <h1>Hancom Page Audit</h1>
  <p>모든 테스트 문서를 한컴 Viewer와 TotalDocs 페이지 단위로 대조한 산출물입니다.</p>
  {''.join(cards)}
</main>
</body>
</html>
""", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description="Build per-page Hancom-vs-TotalDocs audit report.")
    parser.add_argument(
        "--manifest",
        default="output/hancom-oracle/page-audit/hancom-page-audit-manifest.json",
    )
    parser.add_argument("--output-dir", default="output/hancom-oracle/page-audit")
    parser.add_argument("--target-width", type=int, default=900)
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    output_dir = Path(args.output_dir)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    results = build_report(manifest, output_dir, args.target_width)

    report_json = output_dir / "hancom-page-audit-report.json"
    report_md = output_dir / "hancom-page-audit-report.md"
    report_html = output_dir / "hancom-page-audit-report.html"
    report_json.write_text(json.dumps({
        "generatedAt": manifest.get("generatedAt"),
        "sourceManifest": str(manifest_path),
        "documentCount": len(results),
        "totalPages": sum(doc["pageCount"] for doc in results),
        "results": results,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_markdown(results, report_md)
    write_html(results, report_html)

    for doc in results:
        print(f"{doc['id']}: pages={doc['pageCount']} verdicts={doc['verdictCounts']}")
    print(f"report={report_json}")
    print(f"markdown={report_md}")
    print(f"html={report_html}")


if __name__ == "__main__":
    main()
