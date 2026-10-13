// Draws the set temperature into the tray icon (Windows tray shows no title text),
// with a mode-colored underline when the AC is on. Mirrors the Electron canvas look.
use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
use tauri::image::Image;

fn load_font() -> Option<FontVec> {
    for path in ["C:/Windows/Fonts/bahnschrift.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"] {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(f) = FontVec::try_from_vec(bytes) {
                return Some(f);
            }
        }
    }
    None
}

pub fn tray_icon(temp: Option<i64>, on: bool, tint: [u8; 3]) -> Image<'static> {
    let size = 32usize;
    let mut px = vec![0u8; size * size * 4];
    let ink = [243u8, 245, 247];
    let alpha = if on { 255u8 } else { 150 };
    let text = temp.map(|t| t.to_string()).unwrap_or_else(|| "--".into());

    if let Some(font) = load_font() {
        let scale = PxScale::from(26.0);
        let scaled = font.as_scaled(scale);
        let mut glyphs = Vec::new();
        let mut caret = 0.0f32;
        for ch in text.chars() {
            let g = font.glyph_id(ch).with_scale_and_position(scale, ab_glyph::point(caret, 0.0));
            caret += scaled.h_advance(font.glyph_id(ch));
            glyphs.push(g);
        }
        let total = caret;
        let x0 = (size as f32 - total) / 2.0;
        let y0 = 24.0; // baseline-ish
        for g in glyphs {
            if let Some(outlined) = font.outline_glyph(g.clone()) {
                let bounds = outlined.px_bounds();
                outlined.draw(|gx, gy, cov| {
                    let x = (x0 + bounds.min.x + gx as f32) as isize;
                    let y = (y0 + bounds.min.y + gy as f32) as isize;
                    if x >= 0 && y >= 0 && (x as usize) < size && (y as usize) < size {
                        let i = (y as usize * size + x as usize) * 4;
                        let a = (cov * alpha as f32) as u8;
                        if a > px[i + 3] {
                            px[i] = ink[0];
                            px[i + 1] = ink[1];
                            px[i + 2] = ink[2];
                            px[i + 3] = a;
                        }
                    }
                });
            }
        }
    }

    if on {
        let bar_y = size - 4;
        for y in bar_y..size {
            for x in 6..size - 6 {
                let i = (y * size + x) * 4;
                px[i] = tint[0];
                px[i + 1] = tint[1];
                px[i + 2] = tint[2];
                px[i + 3] = 255;
            }
        }
    }

    Image::new_owned(px, size as u32, size as u32)
}

pub fn tint_for(modo: &str, on: bool) -> [u8; 3] {
    if !on {
        return [150, 160, 170];
    }
    match modo {
        "dry" => [165, 225, 205],
        "wind" => [213, 220, 227],
        "auto" => [239, 208, 154],
        _ => [167, 215, 241], // cool / frost
    }
}
