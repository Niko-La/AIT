// swift-tools-version:5.9
// Only for running the detection logic's unit tests (`swift test`).
// The watch app itself is built from DeadHang.xcodeproj (see README).
import PackageDescription

let package = Package(
    name: "DeadHangLogic",
    targets: [
        .target(name: "DeadHangLogic", path: "DeadHang/Logic"),
        .testTarget(name: "DeadHangLogicTests", dependencies: ["DeadHangLogic"], path: "Tests"),
    ]
)
