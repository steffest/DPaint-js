# DPaint.js
Webbased image editor modeled after the legendary [Deluxe Paint](https://en.wikipedia.org/wiki/Deluxe_Paint) with a focus on retro Amiga file formats.
Next to modern image formats, DPaint.js can read and write Amiga icon files and IFF ILBM images.

![DPaint.js Logo](./_img/dpaint-logo.png?raw=true)

Online version available at https://www.stef.be/dpaint/

![DPaint.js UI](./_img/ui.png?raw=true)

## Main Features
 - Fully Featured image editor with a.o.
   - Layers
   - Selections
   - Masking
   - Transformation tools
   - Effects and filters
   - Multiple undo/redo
   - Copy/Paste from any other image program or image source
   - Customizable dither tools
 - Heavy focus on colour reduction with fine-grained dithering options
 - Amiga focus
   - Read/write/convert Amiga icon files (all formats)
   - Reads IFF ILBM images (all formats including HAM and 24-bit)
   - Writes IFF ILBM images (up to 256 colors)
   - Read and write directly from Amiga Disk Files (ADF)
   - Embedded Amiga Emulator to preview your work in the real Deluxe Paint.
   - Limit the palette to 12 bit for Amiga OCS/ECS mode, or 9 bit for Atari ST mode.
 - Deluxe Paint Legacy
   - Supports PBM files as used by the PC version of Deluxe Paint (Thanks to [Michael Smith](https://github.com/michaelshmitty))
   - Supports Deluxe Paint Atari ST compression modes (Thanks to [Nicolas Ramz](https://github.com/warpdesign))
## Free and Open
It runs in your browser, works on any system and works fine on touch-screen devices like iPads.  
It is written in 100% plain JavaScript and has no dependencies.  
It's 100% free, no ads, no tracking, no accounts, no nothing.  
All processing is done in your browser, no data is sent to any server.  

The only part that is not included in this repository is the Amiga Emulator Files.
(The emulator is based on the [Scripted Amiga Emulator](https://github.com/naTmeg/ScriptedAmigaEmulator))

## Building
DPaint.js doesn't need building.  
It also has zero dependencies so there's no need to install anything.  
DPaint.js is written using ES6 modules and runs out of the box in modern browsers.  
Just serve "index.html" from a webserver and you're good to go.  

There's an optional build step to create a compact version of DPaint.js if you like.  
I'm using [Parcel.js](https://parceljs.org/) for this.  
For convenience, I've included a "package.json" file.  
open a terminal and run `npm install` to install Parcel.js and its dependencies.
Then run `npm run build` to create a compact version of DPaint.js in the "dist" folder.

## Documentation
Documentation can be found at https://www.stef.be/dpaint/docs/

## Running offline
Dpaint.js is a web application, not an app that you install on your computer.
That being said: DPaint.js has no online dependencies and runs fine offline if you want.
One caveat: you have to serve the index.html file from a webserver, not just open it in your browser.  
A quick way to do this is - for example - using the [Spark](https://github.com/rif/spark/releases) app.  
[Download the binary](https://github.com/rif/spark/releases) for your platform, drop the Spark executable in the folder where you downloaded the Dpaint.js source files and run it.
If you then point your browser to http://localhost:8080/ it should work.  

## Contributing
Current version is still alpha.  
I'm sure there are bugs and missing features.  
Bug reports and pull requests are welcome.

### Missing Features
Planned for the next release, already in the works:
   - <strike>Color Cycling</strike> (done)
   - Animation support (GIf and Amiga ANIM files)
   - <strike>Shading/transparency tools that stay within the palette.</strike> (done)

Planned for a future release if there's a need for it.
  - Support for non-square pixel modes such as HiRes and Interlaced
  - PSD import and export
  - SpriteSheet support
  - Write HAM,SHAM and Dynamic HiRes images

