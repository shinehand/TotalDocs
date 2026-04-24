use crate::model::{BlockInput, BoxLayout, LayoutInput, LayoutResult, PageLayout};

pub fn layout_document(input: &LayoutInput) -> LayoutResult {
    let content_width = input
        .page_width
        .saturating_sub(input.margin_left)
        .saturating_sub(input.margin_right)
        .max(1);
    let content_height = input
        .page_height
        .saturating_sub(input.margin_top)
        .saturating_sub(input.margin_bottom)
        .max(1);
    let page_bottom = input.page_height.saturating_sub(input.margin_bottom).max(1);

    let mut pages = vec![PageLayout {
        index: 0,
        boxes: Vec::new(),
    }];
    let mut y = input.margin_top.min(page_bottom.saturating_sub(1));
    let mut split_blocks = 0;

    for block in &input.blocks {
        let block_height = block.height.max(block.min_height).max(1);
        if block_height <= content_height {
            let current_has_boxes = pages.last().map(|page| !page.boxes.is_empty()).unwrap_or(false);
            if current_has_boxes && y.saturating_add(block_height) > page_bottom {
                push_page(&mut pages);
                y = input.margin_top.min(page_bottom.saturating_sub(1));
            }
            push_box(
                pages.last_mut().expect("layout has at least one page"),
                block,
                input.margin_left,
                y,
                block.width.min(content_width).max(1),
                block_height,
                0,
                block_height,
                0,
                1,
            );
            y = y.saturating_add(block_height);
            continue;
        }

        split_blocks += 1;
        if pages.last().map(|page| !page.boxes.is_empty()).unwrap_or(false) {
            push_page(&mut pages);
        }
        y = input.margin_top.min(page_bottom.saturating_sub(1));

        let fragment_count = ceil_div(block_height, content_height);
        let mut source_start = 0;
        for fragment_index in 0..fragment_count {
            if fragment_index > 0 {
                push_page(&mut pages);
                y = input.margin_top.min(page_bottom.saturating_sub(1));
            }
            let visible_height = (block_height - source_start).min(content_height).max(1);
            push_box(
                pages.last_mut().expect("layout has at least one page"),
                block,
                input.margin_left,
                y,
                block.width.min(content_width).max(1),
                visible_height,
                source_start,
                visible_height,
                fragment_index,
                fragment_count,
            );
            source_start = source_start.saturating_add(visible_height);
            y = y.saturating_add(visible_height);
        }
    }

    LayoutResult {
        page_width: input.page_width,
        page_height: input.page_height,
        content_width,
        content_height,
        block_count: input.blocks.len() as u32,
        split_blocks,
        pages,
    }
}

fn push_page(pages: &mut Vec<PageLayout>) {
    let index = pages.len() as u32;
    pages.push(PageLayout {
        index,
        boxes: Vec::new(),
    });
}

#[allow(clippy::too_many_arguments)]
fn push_box(
    page: &mut PageLayout,
    block: &BlockInput,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    source_start: u32,
    visible_height: u32,
    fragment_index: u32,
    fragment_count: u32,
) {
    page.boxes.push(BoxLayout {
        kind: block.kind,
        source_index: block.source_index,
        flags: block.flags,
        x,
        y,
        width,
        height,
        source_start,
        visible_height,
        fragment_index,
        fragment_count,
    });
}

fn ceil_div(value: u32, divisor: u32) -> u32 {
    if divisor == 0 {
        return 1;
    }
    value.saturating_add(divisor - 1) / divisor
}

impl LayoutResult {
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        out.push_str("{\"engine\":\"totaldocs\",\"version\":1");
        out.push_str(&format!(
            ",\"pageWidth\":{},\"pageHeight\":{},\"contentWidth\":{},\"contentHeight\":{}",
            self.page_width, self.page_height, self.content_width, self.content_height
        ));
        out.push_str(&format!(",\"pageCount\":{}", self.pages.len()));
        out.push_str(",\"pages\":[");
        for (page_index, page) in self.pages.iter().enumerate() {
            if page_index > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"index\":{},\"boxes\":[", page.index));
            for (box_index, item) in page.boxes.iter().enumerate() {
                if box_index > 0 {
                    out.push(',');
                }
                out.push_str(&format!(
                    "{{\"kind\":\"{}\",\"sourceIndex\":{},\"flags\":{},\"x\":{},\"y\":{},\"width\":{},\"height\":{},\"sourceStart\":{},\"visibleHeight\":{},\"fragmentIndex\":{},\"fragmentCount\":{}}}",
                    item.kind.as_str(),
                    item.source_index,
                    item.flags,
                    item.x,
                    item.y,
                    item.width,
                    item.height,
                    item.source_start,
                    item.visible_height,
                    item.fragment_index,
                    item.fragment_count,
                ));
            }
            out.push_str("]}");
        }
        out.push_str("],\"diagnostics\":");
        out.push_str(&format!(
            "{{\"blockCount\":{},\"splitBlocks\":{}}}",
            self.block_count, self.split_blocks
        ));
        out.push('}');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BlockInput, BlockKind, LayoutInput};

    #[test]
    fn paginates_blocks_when_page_is_full() {
        let input = LayoutInput {
            page_width: 800,
            page_height: 1000,
            margin_top: 100,
            margin_right: 100,
            margin_bottom: 100,
            margin_left: 100,
            blocks: vec![
                block(300, 500, 0),
                block(300, 400, 1),
            ],
        };

        let result = layout_document(&input);
        assert_eq!(result.pages.len(), 2);
        assert_eq!(result.pages[0].boxes[0].source_index, 0);
        assert_eq!(result.pages[1].boxes[0].source_index, 1);
    }

    #[test]
    fn splits_tall_block_across_pages() {
        let input = LayoutInput {
            page_width: 800,
            page_height: 1000,
            margin_top: 100,
            margin_right: 100,
            margin_bottom: 100,
            margin_left: 100,
            blocks: vec![block(500, 1800, 7)],
        };

        let result = layout_document(&input);
        assert_eq!(result.pages.len(), 3);
        assert_eq!(result.split_blocks, 1);
        assert_eq!(result.pages[0].boxes[0].fragment_count, 3);
        assert_eq!(result.pages[2].boxes[0].source_start, 1600);
    }

    fn block(width: u32, height: u32, source_index: u32) -> BlockInput {
        BlockInput {
            kind: BlockKind::Paragraph,
            width,
            height,
            min_height: 1,
            flags: 0,
            source_index,
        }
    }
}
