//! Time as text: the ISO stamps stored in chat files and the log stamp. Pure functions on epoch milliseconds.

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_from_march + 2) / 5 + 1) as u32;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn parts(ms: i64) -> (i64, u32, u32, i64, i64, i64, i64) {
    let seconds = ms.div_euclid(1000);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let of_day = seconds.rem_euclid(86_400);
    (
        year,
        month,
        day,
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60,
        ms.rem_euclid(1000),
    )
}

/// The largest time JavaScript's `Date` holds; `toISOString` refuses anything beyond it.
const MAX_DATE_MS: i64 = 8_640_000_000_000_000;

/// `2026-11-05T05:55:38.993Z`, as JavaScript's `Date.prototype.toISOString` writes it for years 0 to 9999;
/// None outside them.
pub fn iso_ms(ms: i64) -> Option<String> {
    if !(0..=253_402_300_799_999).contains(&ms) || ms > MAX_DATE_MS {
        return None;
    }
    let (year, month, day, hour, minute, second, milli) = parts(ms);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z"
    ))
}

/// `2026-11-04 10:00:00,123` in UTC, the stamp at the start of every log line.
pub fn log_stamp(ms: i64) -> String {
    let (year, month, day, hour, minute, second, milli) = parts(ms);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02},{milli:03}")
}
