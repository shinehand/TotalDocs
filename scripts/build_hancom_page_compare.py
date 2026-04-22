#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from statistics import median

from PIL import Image, ImageChops, ImageDraw, ImageStat


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


def detect_page_top_band(image):
    width, height = image.size
    pixels = image.load()
    min_y = max(50, height // 20)
    rows = []

    for y in range(min_y, max(min_y, height - 20)):
        is_white = []
        for x in range(width):
            red, green, blue = pixels[x, y][:3]
            is_white.append(red >= 247 and green >= 247 and blue >= 247)
        left, right, run_width = longest_true_run(is_white)
        if width * 0.45 <= run_width <= width * 0.96:
            rows.append((y, left, right, run_width))

    if not rows:
        raise RuntimeError("Could not detect document page top band")

    clusters = []
    current = [rows[0]]
    for row in rows[1:]:
        if row[0] - current[-1][0] <= 8:
            current.append(row)
        else:
            clusters.append(current)
            current = [row]
    clusters.append(current)

    def cluster_score(cluster):
        y_span = cluster[-1][0] - cluster[0][0]
        avg_run = sum(row[3] for row in cluster) / len(cluster)
        top_bias = max(0, height - cluster[0][0]) / height
        return (y_span * 2) + avg_run + (top_bias * 40)

    clusters.sort(key=cluster_score, reverse=True)
    cluster = clusters[0]
    wide_rows = [row for row in cluster if row[3] >= width * 0.62] or cluster
    left = int(median(row[1] for row in wide_rows))
    right = int(median(row[2] for row in wide_rows))
    top = min(row[0] for row in cluster)
    return left, top, right, cluster[-1][0]


def crop_visible_page(image, kind):
    left, top, right, _ = detect_page_top_band(image)
    page_width = right - left + 1
    reserve = 82 if kind == "hancom" else 46
    bottom_limit = max(top + 1, image.height - reserve)
    a4_bottom = top + int(page_width * 1.414)
    bottom = min(bottom_limit, a4_bottom)

    if bottom <= top + 80:
        bottom = min(image.height, top + max(120, int(page_width * 0.8)))

    return image.crop((left, top, right + 1, bottom))


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


def make_compare_image(hancom_page, chrome_page, output_path, title, target_width):
    hancom = resize_to_width(hancom_page, target_width)
    chrome = resize_to_width(chrome_page, target_width)

    gap = 18
    label_h = 42
    pad = 18
    canvas_w = (target_width * 2) + gap + (pad * 2)
    canvas_h = max(hancom.height, chrome.height) + label_h + (pad * 2)
    canvas = Image.new("RGB", (canvas_w, canvas_h), (238, 235, 229))
    draw = ImageDraw.Draw(canvas)

    draw.text((pad, 12), f"Hancom Viewer - {title}", fill=(80, 44, 31))
    chrome_x = pad + target_width + gap
    draw.text((chrome_x, 12), "TotalDocs", fill=(31, 58, 92))

    top = pad + label_h
    canvas.paste(hancom.convert("RGB"), (pad, top))
    canvas.paste(chrome.convert("RGB"), (chrome_x, top))
    draw.rectangle((pad - 1, top - 1, pad + target_width, top + hancom.height), outline=(176, 161, 141))
    draw.rectangle((chrome_x - 1, top - 1, chrome_x + target_width, top + chrome.height), outline=(176, 161, 141))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path)


def build_for_entry(entry, output_dir, target_width):
    entry_id = entry["id"]
    hancom_path = Path(entry["hancomScreenshot"])
    chrome_path = Path(entry["totalDocsScreenshot"])
    title = entry.get("filename") or entry_id

    hancom_page = crop_visible_page(Image.open(hancom_path).convert("RGB"), "hancom")
    chrome_page = crop_visible_page(Image.open(chrome_path).convert("RGB"), "chrome")

    page_output = output_dir / f"{entry_id}-page-compare.png"
    make_compare_image(hancom_page, chrome_page, page_output, title, target_width)

    title_hancom = hancom_page.crop((0, 0, hancom_page.width, min(hancom_page.height, int(hancom_page.width * 0.35))))
    title_chrome = chrome_page.crop((0, 0, chrome_page.width, min(chrome_page.height, int(chrome_page.width * 0.35))))
    title_output = output_dir / f"{entry_id}-title-compare.png"
    make_compare_image(title_hancom, title_chrome, title_output, title, target_width)

    hancom_norm = resize_to_width(hancom_page, target_width)
    chrome_norm = resize_to_width(chrome_page, target_width)
    title_hancom_norm = resize_to_width(title_hancom, target_width)
    title_chrome_norm = resize_to_width(title_chrome, target_width)

    return {
        "id": entry_id,
        "filename": title,
        "pageCompare": str(page_output),
        "titleCompare": str(title_output),
        "visiblePageDiff": normalized_diff_score(hancom_norm, chrome_norm),
        "titleDiff": normalized_diff_score(title_hancom_norm, title_chrome_norm),
    }


def main():
    parser = argparse.ArgumentParser(description="Build normalized Hancom-vs-TotalDocs page comparison images.")
    parser.add_argument(
        "--manifest",
        default="output/hancom-oracle/hancom-oracle-manifest.json",
        help="Path to hancom-oracle manifest JSON.",
    )
    parser.add_argument(
        "--output-dir",
        default="output/hancom-oracle",
        help="Directory for generated comparison PNG files.",
    )
    parser.add_argument("--target-width", type=int, default=900, help="Normalized page width per side.")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    output_dir = Path(args.output_dir)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("entries") or []
    if not entries:
        raise SystemExit(f"No entries in manifest: {manifest_path}")

    results = [build_for_entry(entry, output_dir, args.target_width) for entry in entries]
    report_path = output_dir / "hancom-page-compare-report.json"
    report_path.write_text(json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for result in results:
        print(
            f"{result['id']}: page={result['pageCompare']} "
            f"title={result['titleCompare']} titleDiff={result['titleDiff']:.2f}"
        )
    print(f"report={report_path}")


if __name__ == "__main__":
    main()
