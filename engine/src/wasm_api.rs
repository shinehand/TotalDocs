use crate::model::decode_layout_input;
use crate::layout::layout_document;

const INPUT_CAPACITY: usize = 4 * 1024 * 1024;
const OUTPUT_CAPACITY: usize = 4 * 1024 * 1024;

static mut INPUT_BUFFER: [u8; INPUT_CAPACITY] = [0; INPUT_CAPACITY];
static mut OUTPUT_BUFFER: [u8; OUTPUT_CAPACITY] = [0; OUTPUT_CAPACITY];
static mut OUTPUT_LEN: u32 = 0;
static mut LAST_ERROR: u32 = 0;

#[no_mangle]
pub extern "C" fn td_version() -> u32 {
    1
}

#[no_mangle]
pub extern "C" fn td_input_ptr() -> u32 {
    core::ptr::addr_of_mut!(INPUT_BUFFER) as *mut u8 as u32
}

#[no_mangle]
pub extern "C" fn td_input_capacity() -> u32 {
    INPUT_CAPACITY as u32
}

#[no_mangle]
pub extern "C" fn td_output_ptr() -> u32 {
    core::ptr::addr_of_mut!(OUTPUT_BUFFER) as *mut u8 as u32
}

#[no_mangle]
pub extern "C" fn td_output_len() -> u32 {
    unsafe { OUTPUT_LEN }
}

#[no_mangle]
pub extern "C" fn td_last_error() -> u32 {
    unsafe { LAST_ERROR }
}

#[no_mangle]
pub extern "C" fn td_layout(input_len: u32) -> i32 {
    unsafe {
        LAST_ERROR = 0;
        OUTPUT_LEN = 0;
    }

    let input_len = input_len as usize;
    if input_len > INPUT_CAPACITY {
        set_error(1);
        return -1;
    }

    let bytes = unsafe {
        core::slice::from_raw_parts(
            core::ptr::addr_of!(INPUT_BUFFER) as *const u8,
            input_len,
        )
    };

    let input = match decode_layout_input(bytes) {
        Ok(input) => input,
        Err(_) => {
            set_error(2);
            return -2;
        }
    };

    let json = layout_document(&input).to_json();
    if json.len() > OUTPUT_CAPACITY {
        set_error(3);
        return -3;
    }

    unsafe {
        core::ptr::copy_nonoverlapping(
            json.as_ptr(),
            core::ptr::addr_of_mut!(OUTPUT_BUFFER) as *mut u8,
            json.len(),
        );
        OUTPUT_LEN = json.len() as u32;
    }
    0
}

fn set_error(code: u32) {
    unsafe {
        LAST_ERROR = code;
    }
}
