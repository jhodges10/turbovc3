//! Pluggable random-access byte source for MXF demux / DNx packet IO.

const std = @import("std");

pub const Reader = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        size: *const fn (*anyopaque) u64,
        read: *const fn (*anyopaque, offset: u64, dest: []u8) anyerror!void,
    };

    pub fn size(self: Reader) u64 {
        return self.vtable.size(self.ptr);
    }

    pub fn read(self: Reader, offset: u64, dest: []u8) !void {
        return self.vtable.read(self.ptr, offset, dest);
    }

    pub fn readAlloc(self: Reader, allocator: std.mem.Allocator, offset: u64, length: usize) ![]u8 {
        const buf = try allocator.alloc(u8, length);
        errdefer allocator.free(buf);
        try self.read(offset, buf);
        return buf;
    }
};

pub const SliceReader = struct {
    bytes: []const u8,

    pub fn reader(self: *SliceReader) Reader {
        return .{
            .ptr = self,
            .vtable = &.{
                .size = sizeFn,
                .read = readFn,
            },
        };
    }

    fn sizeFn(ptr: *anyopaque) u64 {
        const self: *SliceReader = @ptrCast(@alignCast(ptr));
        return self.bytes.len;
    }

    fn readFn(ptr: *anyopaque, offset: u64, dest: []u8) anyerror!void {
        const self: *SliceReader = @ptrCast(@alignCast(ptr));
        if (offset > self.bytes.len or offset + dest.len > self.bytes.len) return error.OutOfBounds;
        @memcpy(dest, self.bytes[@intCast(offset)..][0..dest.len]);
    }
};

pub const FileReader = struct {
    file: std.Io.File,
    io: std.Io,
    file_size: u64,

    pub fn open(io: std.Io, path: []const u8) !FileReader {
        const file = if (std.Io.Dir.path.isAbsolute(path))
            try std.Io.Dir.openFileAbsolute(io, path, .{})
        else
            try std.Io.Dir.cwd().openFile(io, path, .{});
        const st = try file.stat(io);
        return .{ .file = file, .io = io, .file_size = st.size };
    }

    pub fn deinit(self: *FileReader) void {
        self.file.close(self.io);
    }

    pub fn reader(self: *FileReader) Reader {
        return .{
            .ptr = self,
            .vtable = &.{
                .size = sizeFn,
                .read = readFn,
            },
        };
    }

    fn sizeFn(ptr: *anyopaque) u64 {
        const self: *FileReader = @ptrCast(@alignCast(ptr));
        return self.file_size;
    }

    fn readFn(ptr: *anyopaque, offset: u64, dest: []u8) anyerror!void {
        const self: *FileReader = @ptrCast(@alignCast(ptr));
        if (offset > self.file_size or offset + dest.len > self.file_size) return error.OutOfBounds;
        _ = try self.file.readPositionalAll(self.io, dest, offset);
    }
};
