//! OP1a MXF demuxer — faithful port of src/mxf/mxfDemuxer.ts for native Zig.

const std = @import("std");
const reader_mod = @import("../reader.zig");
const binary = @import("binary.zig");
const types = @import("types.zig");
const index_mod = @import("index.zig");
pub const pcm = @import("pcm.zig");

pub const Reader = reader_mod.Reader;

const klv_prefix = [_]u8{ 0x06, 0x0e, 0x2b, 0x34 };
const partition_prefix = "060e2b34020501010d01020101";
const primer_key = "060e2b34020501010d01020101050100";
const random_index_key = "060e2b34020501010d01020101110100";
const index_table_key = "060e2b34025301010d01020101100100";
const generic_essence = "060e2b34010201010d010301";
const avid_essence = "060e2b34010201010e040301";
const canopus_essence = "060e2b340102010a0e0f0301";

const MetadataType = struct { key: []const u8, name: []const u8 };
const metadata_types = [_]MetadataType{
    .{ .key = "060e2b34025301010d01010101012f00", .name = "Preface" },
    .{ .key = "060e2b34025301010d01010101013000", .name = "Identification" },
    .{ .key = "060e2b34025301010d01010101011800", .name = "ContentStorage" },
    .{ .key = "060e2b34025301010d01010101013700", .name = "SourcePackage" },
    .{ .key = "060e2b34025301010d01010101013600", .name = "MaterialPackage" },
    .{ .key = "060e2b34025301010d01010101010f00", .name = "Sequence" },
    .{ .key = "060e2b34025301010d01010101011100", .name = "SourceClip" },
    .{ .key = "060e2b34025301010d01010101014400", .name = "MultipleDescriptor" },
    .{ .key = "060e2b34025301010d01010101014200", .name = "GenericSoundDescriptor" },
    .{ .key = "060e2b34025301010d01010101012800", .name = "CDCIDescriptor" },
    .{ .key = "060e2b34025301010d01010101012900", .name = "RGBADescriptor" },
    .{ .key = "060e2b34025301010d01010101014800", .name = "WaveAudioDescriptor" },
    .{ .key = "060e2b34025301010d01010101014700", .name = "AES3AudioDescriptor" },
    .{ .key = "060e2b34025301010d01010101013a00", .name = "StaticTrack" },
    .{ .key = "060e2b34025301010d01010101013b00", .name = "Track" },
    .{ .key = "060e2b34025301010d01010101011400", .name = "TimecodeComponent" },
    .{ .key = "060e2b34025301010d01010101012300", .name = "EssenceContainerData" },
    .{ .key = index_table_key, .name = "IndexTableSegment" },
};

pub const Limits = struct {
    max_metadata_value_bytes: usize = 64 * 1024 * 1024,
    max_metadata_sets: usize = 100_000,
    max_klv_packets: usize = 2_000_000,
    max_tracks: usize = 1_024,
    max_packets: usize = 2_000_000,
    max_resync_bytes: usize = 16 * 1024 * 1024,
};

pub const Demux = struct {
    allocator: std.mem.Allocator,
    partitions: []types.Partition,
    metadata_sets: []types.MetadataSet,
    descriptors: []types.Descriptor,
    tracks: []types.Track,
    essence: []types.EssenceElement,
    index_segments: []types.IndexTableSegment,
    packets: []types.Packet,
    primer: std.AutoHashMap(u16, [32]u8),
    operational_pattern: ?[32]u8 = null,

    pub fn deinit(self: *Demux) void {
        for (self.metadata_sets) |*set| {
            for (set.items) |item| self.allocator.free(item.value);
            self.allocator.free(set.items);
        }
        self.allocator.free(self.metadata_sets);
        self.allocator.free(self.partitions);
        self.allocator.free(self.descriptors);
        self.allocator.free(self.tracks);
        self.allocator.free(self.essence);
        for (self.index_segments) |seg| self.allocator.free(seg.entries);
        self.allocator.free(self.index_segments);
        self.allocator.free(self.packets);
        self.primer.deinit();
    }

    pub fn packetsForTrack(self: *const Demux, track_index: usize) PacketIter {
        return .{ .demux = self, .track_index = track_index, .cursor = 0 };
    }

    pub fn readPacket(self: *const Demux, source: Reader, packet: types.Packet) ![]u8 {
        return source.readAlloc(self.allocator, packet.byte_offset, @intCast(packet.byte_length));
    }

    pub fn primaryVideoTrack(self: *const Demux) ?usize {
        for (self.tracks, 0..) |track, i| if (track.kind == .video) return i;
        return null;
    }

    pub fn primaryAudioTrack(self: *const Demux) ?usize {
        for (self.tracks, 0..) |track, i| if (track.kind == .audio) return i;
        return null;
    }
};

pub const PacketIter = struct {
    demux: *const Demux,
    track_index: usize,
    cursor: usize,

    pub fn next(self: *PacketIter) ?types.Packet {
        while (self.cursor < self.demux.packets.len) {
            const packet = self.demux.packets[self.cursor];
            self.cursor += 1;
            if (packet.track_index == self.track_index) return packet;
        }
        return null;
    }
};

pub fn demux(allocator: std.mem.Allocator, source: Reader, limits: Limits) !Demux {
    var partitions: std.ArrayListUnmanaged(types.Partition) = .empty;
    errdefer partitions.deinit(allocator);
    var metadata_sets: std.ArrayListUnmanaged(types.MetadataSet) = .empty;
    errdefer {
        for (metadata_sets.items) |*set| {
            for (set.items) |item| allocator.free(item.value);
            allocator.free(set.items);
        }
        metadata_sets.deinit(allocator);
    }
    var essence: std.ArrayListUnmanaged(types.EssenceElement) = .empty;
    errdefer essence.deinit(allocator);
    var index_segments: std.ArrayListUnmanaged(types.IndexTableSegment) = .empty;
    errdefer {
        for (index_segments.items) |seg| allocator.free(seg.entries);
        index_segments.deinit(allocator);
    }
    var primer = std.AutoHashMap(u16, [32]u8).init(allocator);
    errdefer primer.deinit();

    var operational_pattern: ?[32]u8 = null;
    var current_body_sid: u32 = 0;
    var offset: u64 = 0;
    const size = source.size();
    var klv_count: usize = 0;

    while (offset + 17 <= size) {
        const klv = try readKlvAt(source, offset) orelse {
            const next = try findNextKlv(source, offset + 1, limits.max_resync_bytes);
            if (next == null) break;
            offset = next.?;
            continue;
        };
        klv_count += 1;
        if (klv_count > limits.max_klv_packets) return error.TooManyKlvPackets;

        var key_hex_buf: [32]u8 = undefined;
        const key_hex = klv.keyHex(&key_hex_buf);

        if (isPartitionKey(klv)) {
            const partition = try parsePartition(source, klv);
            try partitions.append(allocator, partition);
            current_body_sid = partition.body_sid;
            if (operational_pattern == null) operational_pattern = partition.operational_pattern;
        } else if (std.mem.eql(u8, key_hex, primer_key)) {
            try parsePrimer(source, klv, limits.max_metadata_value_bytes, &primer);
        } else if (isEssenceKey(key_hex)) {
            const track_number = binary.readU32BE(&klv.key, 12);
            try essence.append(allocator, .{
                .index = essence.items.len,
                .track_number = track_number,
                .item_type = klv.key[12],
                .element_count = klv.key[13],
                .element_type = klv.key[14],
                .element_number = klv.key[15],
                .body_sid = current_body_sid,
                .klv = klv,
            });
        } else if (std.mem.eql(u8, key_hex, random_index_key)) {
            // validated later if needed; skip storage for v1
        } else if (metadataTypeName(key_hex)) |type_name| {
            const set = try parseMetadataSet(allocator, source, klv, type_name, &primer, limits.max_metadata_value_bytes);
            try metadata_sets.append(allocator, set);
            if (metadata_sets.items.len > limits.max_metadata_sets) return error.TooManyMetadataSets;
            if (std.mem.eql(u8, key_hex, index_table_key)) {
                try index_segments.append(allocator, try parseIndexTable(allocator, set));
            }
        }
        offset = klv.next_offset;
    }

    const descriptors = try buildDescriptors(allocator, metadata_sets.items);
    const tracks = try buildTracks(allocator, metadata_sets.items, descriptors, essence.items);
    const packets = try buildPackets(allocator, tracks, essence.items, index_segments.items);
    for (tracks, 0..) |*track, ti| {
        var count: usize = 0;
        for (packets) |packet| {
            if (packet.track_index == ti) count += 1;
        }
        track.packet_count = count;
    }

    return .{
        .allocator = allocator,
        .partitions = try partitions.toOwnedSlice(allocator),
        .metadata_sets = try metadata_sets.toOwnedSlice(allocator),
        .descriptors = descriptors,
        .tracks = tracks,
        .essence = try essence.toOwnedSlice(allocator),
        .index_segments = try index_segments.toOwnedSlice(allocator),
        .packets = packets,
        .primer = primer,
        .operational_pattern = operational_pattern,
    };
}

fn metadataTypeName(key_hex: []const u8) ?[]const u8 {
    for (metadata_types) |entry| if (std.mem.eql(u8, entry.key, key_hex)) return entry.name;
    return null;
}

fn isEssenceKey(key_hex: []const u8) bool {
    return std.mem.startsWith(u8, key_hex, generic_essence) or std.mem.startsWith(u8, key_hex, avid_essence) or std.mem.startsWith(u8, key_hex, canopus_essence);
}

fn isPartitionKey(klv: types.KlvPacket) bool {
    var buf: [32]u8 = undefined;
    const hex = klv.keyHex(&buf);
    return std.mem.startsWith(u8, hex, partition_prefix) and klv.key[13] >= 2 and klv.key[13] <= 4;
}

fn readKlvAt(source: Reader, offset: u64) !?types.KlvPacket {
    const available: usize = @intCast(@min(@as(u64, 25), source.size() -| offset));
    if (available < 17) return null;
    var header: [25]u8 = undefined;
    try source.read(offset, header[0..available]);
    if (!binary.matchesPrefix(header[0..available], 0, &klv_prefix)) return null;
    const first = header[16];
    const long_form = (first & 0x80) != 0;
    const length_bytes: usize = if (long_form) first & 0x7f else 0;
    if (long_form and length_bytes == 0) return error.IndefiniteBerLength;
    if (long_form and length_bytes > 8) return error.InvalidBerLength;
    if (long_form and 17 + length_bytes > available) return error.TruncatedBerLength;
    const length_field_length: u8 = if (long_form) @intCast(1 + length_bytes) else 1;
    var value_length: u64 = if (long_form) 0 else first;
    var i: usize = 0;
    while (i < length_bytes) : (i += 1) value_length = (value_length << 8) | header[17 + i];
    const value_offset = offset + 16 + length_field_length;
    const next_offset = value_offset + value_length;
    if (next_offset > source.size()) return error.KlvPastEof;
    var key: [16]u8 = undefined;
    @memcpy(&key, header[0..16]);
    return .{
        .offset = offset,
        .key = key,
        .length_field_length = length_field_length,
        .value_offset = value_offset,
        .value_length = value_length,
        .next_offset = next_offset,
    };
}

fn findNextKlv(source: Reader, start: u64, max_resync: usize) !?u64 {
    var offset = start;
    const limit = @min(source.size(), start + max_resync);
    var chunk: [64 * 1024]u8 = undefined;
    while (offset + klv_prefix.len <= limit) {
        const length: usize = @intCast(@min(chunk.len, limit - offset));
        try source.read(offset, chunk[0..length]);
        var index: usize = 0;
        while (index + klv_prefix.len <= length) : (index += 1) {
            if (binary.matchesPrefix(chunk[0..length], index, &klv_prefix)) return offset + index;
        }
        if (length <= klv_prefix.len) break;
        offset += length - (klv_prefix.len - 1);
    }
    if (limit < source.size()) return error.ResyncLimitExceeded;
    return null;
}

fn parsePartition(source: Reader, klv: types.KlvPacket) !types.Partition {
    if (klv.value_length < 80) return error.ShortPartition;
    var bytes: [88]u8 = undefined;
    const n: usize = @intCast(@min(klv.value_length, 88));
    try source.read(klv.value_offset, bytes[0..n]);
    var op: [32]u8 = undefined;
    _ = binary.hexInto(&op, bytes[64..80]);
    return .{
        .kind = switch (klv.key[13]) {
            2 => .header,
            3 => .body,
            4 => .footer,
            else => .unknown,
        },
        .status = klv.key[14],
        .offset = klv.offset,
        .major_version = binary.readU16BE(&bytes, 0),
        .minor_version = binary.readU16BE(&bytes, 2),
        .kag_size = binary.readU32BE(&bytes, 4),
        .this_partition = binary.readU64BE(&bytes, 8),
        .previous_partition = binary.readU64BE(&bytes, 16),
        .footer_partition = binary.readU64BE(&bytes, 24),
        .header_byte_count = binary.readU64BE(&bytes, 32),
        .index_byte_count = binary.readU64BE(&bytes, 40),
        .index_sid = binary.readU32BE(&bytes, 48),
        .body_offset = binary.readU64BE(&bytes, 52),
        .body_sid = binary.readU32BE(&bytes, 60),
        .operational_pattern = op,
    };
}

fn parsePrimer(source: Reader, klv: types.KlvPacket, max_bytes: usize, primer: *std.AutoHashMap(u16, [32]u8)) !void {
    if (klv.value_length > max_bytes) return error.MetadataTooLarge;
    const bytes = try source.readAlloc(primer.allocator, klv.value_offset, @intCast(klv.value_length));
    defer primer.allocator.free(bytes);
    if (bytes.len < 8) return;
    const count = binary.readU32BE(bytes, 0);
    const item_length = binary.readU32BE(bytes, 4);
    if (item_length < 18 or 8 + count * item_length > bytes.len) return error.InvalidPrimer;
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        const off: usize = 8 + i * item_length;
        const tag = binary.readU16BE(bytes, off);
        var ul: [32]u8 = undefined;
        _ = binary.hexInto(&ul, bytes[off + 2 ..][0..16]);
        try primer.put(tag, ul);
    }
}

fn parseMetadataSet(
    allocator: std.mem.Allocator,
    source: Reader,
    klv: types.KlvPacket,
    type_name: []const u8,
    primer: *const std.AutoHashMap(u16, [32]u8),
    max_bytes: usize,
) !types.MetadataSet {
    _ = primer;
    if (klv.value_length > max_bytes) return error.MetadataTooLarge;
    const bytes = try source.readAlloc(allocator, klv.value_offset, @intCast(klv.value_length));
    defer allocator.free(bytes);
    var items: std.ArrayListUnmanaged(types.LocalSetItem) = .empty;
    errdefer {
        for (items.items) |item| allocator.free(item.value);
        items.deinit(allocator);
    }
    var offset: usize = 0;
    while (offset + 4 <= bytes.len) {
        const local_tag = binary.readU16BE(bytes, offset);
        const length = binary.readU16BE(bytes, offset + 2);
        offset += 4;
        if (offset + length > bytes.len) return error.LocalTagOverrun;
        const value = try allocator.dupe(u8, bytes[offset .. offset + length]);
        try items.append(allocator, .{ .local_tag = local_tag, .value = value });
        offset += length;
    }
    if (offset != bytes.len) return error.TrailingLocalSetBytes;
    var key_hex: [32]u8 = undefined;
    _ = klv.keyHex(&key_hex);
    var instance_uid: ?[32]u8 = null;
    if (itemBytes(items.items, 0x3c0a)) |uid| {
        if (uid.len >= 16) {
            var hex: [32]u8 = undefined;
            _ = binary.hexInto(&hex, uid[0..16]);
            instance_uid = hex;
        }
    }
    return .{
        .type_name = type_name,
        .key_hex = key_hex,
        .offset = klv.offset,
        .instance_uid = instance_uid,
        .items = try items.toOwnedSlice(allocator),
    };
}

fn itemBytes(items: []const types.LocalSetItem, tag: u16) ?[]const u8 {
    for (items) |item| if (item.local_tag == tag) return item.value;
    return null;
}
fn itemU32(set: types.MetadataSet, tag: u16) ?u32 {
    const value = itemBytes(set.items, tag) orelse return null;
    if (value.len < 4) return null;
    return binary.readU32BE(value, 0);
}
fn itemU16(set: types.MetadataSet, tag: u16) ?u16 {
    const value = itemBytes(set.items, tag) orelse return null;
    if (value.len < 2) return null;
    return binary.readU16BE(value, 0);
}
fn itemI64(set: types.MetadataSet, tag: u16) ?i64 {
    const value = itemBytes(set.items, tag) orelse return null;
    if (value.len < 8) return null;
    return binary.readI64BE(value, 0);
}
fn itemRational(set: types.MetadataSet, tag: u16) ?types.Rational {
    const value = itemBytes(set.items, tag) orelse return null;
    if (value.len < 8) return null;
    const num = binary.readU32BE(value, 0);
    const den = binary.readU32BE(value, 4);
    if (num == 0 or den == 0) return null;
    return .{ .numerator = num, .denominator = den };
}

fn parseIndexTable(allocator: std.mem.Allocator, set: types.MetadataSet) !types.IndexTableSegment {
    var entries: std.ArrayListUnmanaged(types.IndexEntry) = .empty;
    errdefer entries.deinit(allocator);
    if (itemBytes(set.items, 0x3f0a)) |entry_array| {
        if (entry_array.len < 8) return error.ShortIndexArray;
        const count = binary.readU32BE(entry_array, 0);
        const item_length = binary.readU32BE(entry_array, 4);
        if (item_length < 11 or 8 + count * item_length > entry_array.len) return error.InvalidIndexArray;
        var i: u32 = 0;
        while (i < count) : (i += 1) {
            const off: usize = 8 + i * item_length;
            try entries.append(allocator, .{
                .temporal_offset = binary.signedByte(entry_array[off]),
                .key_frame_offset = binary.signedByte(entry_array[off + 1]),
                .flags = entry_array[off + 2],
                .stream_offset = binary.readU64BE(entry_array, off + 3),
            });
        }
    }
    return .{
        .offset = set.offset,
        .index_edit_rate = itemRational(set, 0x3f0b),
        .index_start_position = itemI64(set, 0x3f0c) orelse 0,
        .index_duration = itemI64(set, 0x3f0d) orelse 0,
        .edit_unit_byte_count = itemU32(set, 0x3f05) orelse 0,
        .index_sid = itemU32(set, 0x3f06) orelse 0,
        .body_sid = itemU32(set, 0x3f07) orelse 0,
        .entries = try entries.toOwnedSlice(allocator),
    };
}

fn buildDescriptors(allocator: std.mem.Allocator, sets: []const types.MetadataSet) ![]types.Descriptor {
    var list: std.ArrayListUnmanaged(types.Descriptor) = .empty;
    errdefer list.deinit(allocator);
    for (sets) |set| {
        if (!std.mem.endsWith(u8, set.type_name, "Descriptor")) continue;
        const channels = itemU32(set, 0x3d07);
        const bits = itemU32(set, 0x3d01);
        const block_align = itemU16(set, 0x3d0a);
        const stored: ?u32 = if (block_align != null and channels != null and block_align.? % @as(u16, @intCast(channels.?)) == 0)
            @as(u32, block_align.? / @as(u16, @intCast(channels.?))) * 8
        else
            bits;
        try list.append(allocator, .{
            .instance_uid = set.instance_uid,
            .linked_track_id = itemU32(set, 0x3006),
            .width = itemU32(set, 0x3203),
            .height = itemU32(set, 0x3202),
            .component_depth = itemU32(set, 0x3301),
            .sample_rate = itemRational(set, 0x3d03),
            .channels = channels,
            .bits_per_sample = bits,
            .stored_bits_per_sample = stored,
            .block_align = block_align,
            .duration = itemI64(set, 0x3002),
        });
    }
    return try list.toOwnedSlice(allocator);
}

fn kindForEssence(element: types.EssenceElement) types.TrackKind {
    return switch (element.item_type) {
        0x14 => .system,
        0x15 => .video,
        0x16 => .audio,
        0x17 => .data,
        else => .unknown,
    };
}

fn buildTracks(
    allocator: std.mem.Allocator,
    sets: []const types.MetadataSet,
    descriptors: []const types.Descriptor,
    essence: []const types.EssenceElement,
) ![]types.Track {
    // Group essence by bodySid:trackNumber
    var groups = std.AutoHashMap(u64, std.ArrayListUnmanaged(types.EssenceElement)).init(allocator);
    defer {
        var it = groups.valueIterator();
        while (it.next()) |list| list.deinit(allocator);
        groups.deinit();
    }
    for (essence) |element| {
        const key = (@as(u64, element.body_sid) << 32) | element.track_number;
        const g = try groups.getOrPut(key);
        if (!g.found_existing) g.value_ptr.* = .empty;
        try g.value_ptr.append(allocator, element);
    }

    var tracks: std.ArrayListUnmanaged(types.Track) = .empty;
    errdefer tracks.deinit(allocator);

    for (sets) |set| {
        if (!std.mem.eql(u8, set.type_name, "Track") and !std.mem.eql(u8, set.type_name, "StaticTrack")) continue;
        const id = itemU32(set, 0x4801) orelse continue;
        const number_bytes = itemBytes(set.items, 0x4804) orelse continue;
        if (number_bytes.len < 4) continue;
        const number = binary.readU32BE(number_bytes, 0);
        const edit_rate = itemRational(set, 0x4b01) orelse continue;
        // Match essence groups by track number
        var git = groups.iterator();
        while (git.next()) |entry| {
            const elements = entry.value_ptr.*.items;
            if (elements.len == 0 or elements[0].track_number != number) continue;
            const descriptor = blk: {
                for (descriptors) |d| if (d.linked_track_id == id) break :blk d;
                break :blk null;
            };
            try tracks.append(allocator, .{
                .id = id,
                .number = number,
                .kind = kindForEssence(elements[0]),
                .edit_rate = edit_rate,
                .origin = itemI64(set, 0x4b02) orelse 0,
                .duration = null,
                .descriptor = descriptor,
                .body_sid = elements[0].body_sid,
                .packet_count = elements.len,
            });
        }
    }

    // Fallback: essence-only tracks
    var git = groups.iterator();
    while (git.next()) |entry| {
        const elements = entry.value_ptr.*.items;
        if (elements.len == 0) continue;
        const number = elements[0].track_number;
        const body_sid = elements[0].body_sid;
        var exists = false;
        for (tracks.items) |t| if (t.number == number and t.body_sid == body_sid) {
            exists = true;
            break;
        };
        if (exists) continue;
        try tracks.append(allocator, .{
            .id = number,
            .number = number,
            .kind = kindForEssence(elements[0]),
            .edit_rate = .{ .numerator = 1, .denominator = 1 },
            .duration = @intCast(elements.len),
            .body_sid = body_sid,
            .packet_count = elements.len,
        });
    }
    return try tracks.toOwnedSlice(allocator);
}

fn buildPackets(
    allocator: std.mem.Allocator,
    tracks: []const types.Track,
    essence: []const types.EssenceElement,
    indexes: []const types.IndexTableSegment,
) ![]types.Packet {
    var packets: std.ArrayListUnmanaged(types.Packet) = .empty;
    errdefer packets.deinit(allocator);
    var counters = std.AutoHashMap(u64, u32).init(allocator);
    defer counters.deinit();
    var elements_per_track = std.AutoHashMap(u64, usize).init(allocator);
    defer elements_per_track.deinit();
    for (essence) |element| {
        const key = (@as(u64, element.body_sid) << 32) | element.track_number;
        const g = try elements_per_track.getOrPut(key);
        if (!g.found_existing) g.value_ptr.* = 0;
        g.value_ptr.* += 1;
    }

    for (essence) |element| {
        const key = (@as(u64, element.body_sid) << 32) | element.track_number;
        var track_index: ?usize = null;
        for (tracks, 0..) |track, ti| {
            if (track.number == element.track_number and track.body_sid == element.body_sid) {
                track_index = ti;
                break;
            }
        }
        const ti = track_index orelse continue;
        var slice_buf: [4096]index_mod.EssenceSlice = undefined;
        const slices = try index_mod.essenceSlices(
            element.klv.value_length,
            elements_per_track.get(key) orelse 1,
            element.body_sid,
            indexes,
            &slice_buf,
        );
        for (slices) |slice| {
            const g = try counters.getOrPut(key);
            if (!g.found_existing) g.value_ptr.* = 0;
            const pkt_index = g.value_ptr.*;
            g.value_ptr.* += 1;
            const index_entry = index_mod.indexEntryAt(indexes, element.body_sid, @intCast(pkt_index));
            try packets.append(allocator, .{
                .track_index = ti,
                .index = pkt_index,
                .byte_offset = element.klv.value_offset + slice.offset,
                .byte_length = slice.length,
                .keyframe = if (index_entry) |e| (e.flags & 0x80) != 0 else null,
            });
        }
    }
    return try packets.toOwnedSlice(allocator);
}

test "klv prefix constant" {
    try std.testing.expectEqual(@as(u8, 0x06), klv_prefix[0]);
}
