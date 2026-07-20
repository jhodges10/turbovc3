const binary = @import("binary.zig");
const std = @import("std");

pub const Rational = struct { numerator: u32, denominator: u32 };

pub const KlvPacket = struct {
    offset: u64,
    key: [16]u8,
    length_field_length: u8,
    value_offset: u64,
    value_length: u64,
    next_offset: u64,

    pub fn keyHex(self: KlvPacket, buf: *[32]u8) []const u8 {
        return binary.hexInto(buf, &self.key);
    }
};

pub const PartitionKind = enum { header, body, footer, unknown };

pub const Partition = struct {
    kind: PartitionKind,
    status: u8,
    offset: u64,
    major_version: u16,
    minor_version: u16,
    kag_size: u32,
    this_partition: u64,
    previous_partition: u64,
    footer_partition: u64,
    header_byte_count: u64,
    index_byte_count: u64,
    index_sid: u32,
    body_offset: u64,
    body_sid: u32,
    operational_pattern: [32]u8,
};

pub const LocalSetItem = struct {
    local_tag: u16,
    value: []u8,
};

pub const MetadataSet = struct {
    type_name: []const u8,
    key_hex: [32]u8,
    offset: u64,
    instance_uid: ?[32]u8,
    items: []LocalSetItem,
};

pub const TrackKind = enum { video, audio, data, system, unknown };

pub const Descriptor = struct {
    instance_uid: ?[32]u8 = null,
    linked_track_id: ?u32 = null,
    width: ?u32 = null,
    height: ?u32 = null,
    component_depth: ?u32 = null,
    sample_rate: ?Rational = null,
    channels: ?u32 = null,
    bits_per_sample: ?u32 = null,
    stored_bits_per_sample: ?u32 = null,
    block_align: ?u16 = null,
    duration: ?i64 = null,
};

pub const Track = struct {
    id: u32,
    number: u32,
    kind: TrackKind,
    edit_rate: Rational,
    origin: i64 = 0,
    duration: ?i64 = null,
    descriptor: ?Descriptor = null,
    body_sid: u32 = 0,
    packet_count: usize = 0,
};

pub const EssenceElement = struct {
    index: usize,
    track_number: u32,
    item_type: u8,
    element_count: u8,
    element_type: u8,
    element_number: u8,
    body_sid: u32,
    klv: KlvPacket,
};

pub const IndexEntry = struct {
    temporal_offset: i8,
    key_frame_offset: i8,
    flags: u8,
    stream_offset: u64,
};

pub const IndexTableSegment = struct {
    offset: u64,
    index_edit_rate: ?Rational = null,
    index_start_position: i64 = 0,
    index_duration: i64 = 0,
    edit_unit_byte_count: u32 = 0,
    index_sid: u32 = 0,
    body_sid: u32 = 0,
    entries: []IndexEntry,
};

pub const RandomIndexEntry = struct { body_sid: u32, byte_offset: u64 };

pub const Packet = struct {
    track_index: usize,
    index: u32,
    byte_offset: u64,
    byte_length: u64,
    keyframe: ?bool = null,
};

pub const TimecodeTrack = struct {
    package_kind: enum { material, source },
    track_id: u32,
    edit_rate: Rational,
    origin: i64 = 0,
    duration: ?i64 = null,
    start_timecode: i64,
    rounded_timecode_base: u16,
    drop_frame: bool,
};
