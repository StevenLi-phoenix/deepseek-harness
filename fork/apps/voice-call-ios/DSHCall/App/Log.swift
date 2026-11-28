import Foundation
import os

/// Unified logging. Subsystem is the bundle identifier. Never log the API token or SDP bodies;
/// log sizes, states, and endpoint names instead.
enum Log {
    static let subsystem: String = Bundle.main.bundleIdentifier ?? "com.example.dshcall"

    static let app = Logger(subsystem: subsystem, category: "app")
    static let push = Logger(subsystem: subsystem, category: "push")
    static let call = Logger(subsystem: subsystem, category: "call")
    static let media = Logger(subsystem: subsystem, category: "media")
    static let api = Logger(subsystem: subsystem, category: "api")
    static let speech = Logger(subsystem: subsystem, category: "speech")
}
