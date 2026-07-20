const std = @import("std");

pub fn readU16BE(bytes: []const u8, offset: usize) u16 {
    return std.mem.readInt(u16, bytes[offset..][0..2], .big);
}

pub fn readU32BE(bytes: []const u8, offset: usize) u32 {
    return std.mem.readInt(u32, bytes[offset..][0..4], .big);
}

pub fn readU64BE(bytes: []const u8, offset: usize) u64 {
    return std.mem.readInt(u64, bytes[offset..][0..8], .big);
}

pub fn readI64BE(bytes: []const u8, offset: usize) i64 {
    return @bitCast(readU64BE(bytes, offset));
}

pub fn signedByte(value: u8) i8 {
    return @bitCast(value);
}

pub fn hexInto(dest: []u8, bytes: []const u8) []const u8 {
    const digits = "0123456789abcdef";
    var i: usize = 0;
    while (i < bytes.len) : (i += 1) {
        dest[i * 2] = digits[bytes[i] >> 4];
        dest[i * 2 + 1] = digits[bytes[i] & 0xf];
    }
    return dest[0 .. bytes.len * 2];
}

pub fn hex(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, bytes.len * 2);
    _ = hexInto(out, bytes);
    return out;
}

pub fn utf16Be(allocator: std.mem.Allocator, bytes: []const u8) ![]u8 {
    var list: std.ArrayListUnmanaged(u8) = .empty;
    errdefer list.deinit(allocator);
    var i: usize = 0;
    while (i + 1 < bytes.len) : (i += 2) {
        const code = readU16BE(bytes, i);
        if (code == 0) continue;
        var buf: [4]u8 = undefined;
        const n = try std.unicode.utf8Encode(code, &buf);
        try list.appendSlice(allocator, buf[0..n]);
    }
    return try list.toOwnedSlice(allocator);
}

pub fn matchesPrefix(bytes: []const u8, offset: usize, prefix: []const u8) bool {
    if (offset + prefix.len > bytes.len) return false;
    return std.mem.eql(u8, bytes[offset..][0..prefix.len], prefix);
}
