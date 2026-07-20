const types = @import("types.zig");

pub const EssenceSlice = struct { offset: u64, length: u64 };

fn segmentLength(segment: types.IndexTableSegment) i64 {
    if (segment.index_duration > 0) return segment.index_duration;
    return @intCast(segment.entries.len);
}

pub fn indexEntryAt(segments: []const types.IndexTableSegment, body_sid: u32, position: i64) ?types.IndexEntry {
    var found: ?types.IndexTableSegment = null;
    for (segments) |segment| {
        const length = segmentLength(segment);
        if (segment.body_sid == body_sid and position >= segment.index_start_position and position < segment.index_start_position + length) {
            if (found != null) return null; // ambiguous
            found = segment;
        }
    }
    const segment = found orelse return null;
    const idx: usize = @intCast(position - segment.index_start_position);
    if (idx >= segment.entries.len) return null;
    return segment.entries[idx];
}

pub fn essenceSlices(
    value_length: u64,
    element_count: usize,
    body_sid: u32,
    segments: []const types.IndexTableSegment,
    out: *[4096]EssenceSlice,
) ![]EssenceSlice {
    var matching_count: usize = 0;
    var matching: [64]types.IndexTableSegment = undefined;
    for (segments) |segment| {
        if (segment.body_sid != body_sid) continue;
        if (matching_count >= matching.len) return error.TooManyIndexSegments;
        matching[matching_count] = segment;
        matching_count += 1;
    }
    // sort by start
    var i: usize = 0;
    while (i + 1 < matching_count) : (i += 1) {
        var j = i + 1;
        while (j < matching_count) : (j += 1) {
            if (matching[j].index_start_position < matching[i].index_start_position) {
                const tmp = matching[i];
                matching[i] = matching[j];
                matching[j] = tmp;
            }
        }
    }
    var edit_unit: u32 = 0;
    var seen_nonzero = false;
    for (matching[0..matching_count]) |segment| {
        if (segment.edit_unit_byte_count == 0) continue;
        if (!seen_nonzero) {
            edit_unit = segment.edit_unit_byte_count;
            seen_nonzero = true;
        } else if (segment.edit_unit_byte_count != edit_unit) return error.ConflictingEditUnitByteCount;
    }
    if (edit_unit > 0 and value_length >= @as(u64, edit_unit) * 2) {
        var duration: i64 = 0;
        var next: ?i64 = null;
        for (matching[0..matching_count]) |segment| {
            const length = segmentLength(segment);
            if (length == 0) continue;
            if (next) |n| if (segment.index_start_position != n) return error.SparseIndex;
            duration += length;
            next = segment.index_start_position + length;
        }
        const units = @min(value_length / edit_unit, if (duration > 0) @as(u64, @intCast(duration)) else std.math.maxInt(u64));
        const count: usize = @intCast(units);
        if (count > out.len) return error.TooManySlices;
        for (0..count) |idx| {
            out[idx] = .{ .offset = idx * edit_unit, .length = edit_unit };
        }
        return out[0..count];
    }
    if (element_count == 1) {
        var entries: [4096]types.IndexEntry = undefined;
        var entry_count: usize = 0;
        var next: ?i64 = null;
        for (matching[0..matching_count]) |segment| {
            if (segment.entries.len == 0) continue;
            if (next) |n| if (segment.index_start_position != n) return error.SparseIndex;
            for (segment.entries) |entry| {
                if (entry_count >= entries.len) return error.TooManySlices;
                entries[entry_count] = entry;
                entry_count += 1;
            }
            next = segment.index_start_position + @as(i64, @intCast(segment.entries.len));
        }
        if (entry_count > 1) {
            const first = entries[0].stream_offset;
            if (entry_count > out.len) return error.TooManySlices;
            for (0..entry_count) |idx| {
                const off = entries[idx].stream_offset - first;
                const end = if (idx + 1 < entry_count) entries[idx + 1].stream_offset - first else value_length;
                out[idx] = .{ .offset = off, .length = end - off };
            }
            return out[0..entry_count];
        }
    }
    out[0] = .{ .offset = 0, .length = value_length };
    return out[0..1];
}

const std = @import("std");
