# DPaint.js
Webbased image editor modeled after the legendary [Deluxe Paint](https://en.wikipedia.org/wiki/Deluxe_Paint) with a focus on retro Amiga file formats.
Next to modern image formats, DPaint.js can read and write Amiga icon files and IFF ILBM images

![DPaint.js](./_img/dpaint-logo.png?raw=true)

*Work in progress*

Currently
 - Heavy focus on colour reduction with fine-grained dithering options
 - Fully Featured image editor with a.o.
   - Layers
   - Selections
   - Masking
   - Transformation tools
   - Effects and filters
 - Amiga focus
   - Read/write/convert Amiga icon files (all formats)
   - Reads IFF ILBM images (all formats including HAM and 24-bit)
   - Writes IFF ILBM images (up to 32 colors)

## Building
DPaint.js doesn't need building.  
It also has zero dependencies so there's no need to install anything.  
DPaint.js is written using ES6 modules and runs out of the box in modern browsers.  
Just serve "index.html" from a webserver and you're good to go.  

There's an optional build step to create a compact version of DPaint.js if you like.  
I'm using Parcel.js for this.  
For convenience, I've included a "package.json" file.  
open a terminal and run `npm install` to install Parcel.js and its dependencies.
Then run `npm run build` to create a compact version of DPaint.js in the "dist" folder.
