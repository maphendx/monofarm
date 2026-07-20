Multi Material Mapping: Bambu Lab AMS support
In this article, we'll cover how SimplyPrint helps make sure you use the right materials / colors for the right parts of each print, if your printer or multi-material add-on supports material "mapping", such as in the case of the Bambu Lab AMS.



AMS not showing for you?
If you didn't pick a Bambu Lab "Combo" printer during the setup, where we automatically set up the AMS support for you, or you have a printer like the P1P that doesn't come in a "Combo" variant, you will have to enable "Multi Material Support" and pick the AMS or AMS Lite for your printer before proceeding. Learn how to do that here; Multi Material Methods: Bambu Lab AMS, Prusa MMU, Palette & more
What is "mapping"?
The reason it's called material "mapping", is that in a sense, we're providing the printer with a map that tells it where it's "destination" (in terms of which materials to pick), is.



So, we provide the printer with a map of the matching filament types and colors for each extruder/color used in a print job.



Without material-mapping - which far from all multi-material hardware supports, if you slice a file that needs to use multiple materials or colors, the first color/material used will always be the first extruder (or the first spool in your multi-material device, such as Bambu Lab AMS), whereas with mapping, the first color used may be the spool in slot/tray/extruder 3, and the next color used be the first extruder/slot/tray.



This way, you don't need to swap filaments too often, as which position/slot the filament is assigned to/in, doesn't really matter!



Which printers / products support it?
Right now, only the Bambu Lab AMS and AMS Lite support Material Mapping in SimplyPrint.
You can read more about it in our explainer of the feature here; Multi Material Methods: Bambu Lab AMS, Prusa MMU, Palette & more



How does material mapping work?
The SimplyPrint Multi Material Mapping feature has 1 purpose; if you're trying to print a file, and the file tells us which colors it's sliced for; the color mapper makes sure to assign the right spools to the right parts of the print.



Material mapping is supported everywhere in SimplyPrint, for all methods to start prints; single-start print, multi-print, 1-click-print, the "Quick queue", and when starting prints via the API.



Examples

A print file needs 3 colors; Blue, White and Yellow. A printer has 4 spools assigned, in this order; Black, Yellow, Blue, White = match first color / Blue with printer's third spool, second color with fourth printer spool and third color with printer's second spool. So even though it's a mix and match, and the colors in the print are used in a different order than the spools are assigned on your printer - and we throw in a fourth color that isn't used in the print, the mapper knows how to map it
A print file has a "White PLA" tag applied, and a printer has 2 spools assigned; first one is Orange PLA, the other is White PLA = match with second material / extruder 2
A print file has a "Orange PLA" tag applied, and a printer has 4 spools assigned; the first 3 ones are Orange, but PETG*, and the fourth is Orange PLA = match with fourth material / extruder, as the analysis is smart enough to not just pick the first color it matches with, if the type (or something else, such as nozzle size tag) isnt' a match


The article continues below the images











Matching levels
Direct match: the color name or color code ("HEX" code) is an exact match (not case sensitive). Example: "Yellow" = "Yellow" or #FFFFF = #FFFFF
Close match: in this, and all following cases, as the color names aren't set or aren't the same, and the HEX codes aren't the same, we check if either the file or the printer has a name for the given color, and then we perform some magic to find the closest color name of the color that is missing a name, and see if these names match
OK match: if neither file nor printer has matching color codes or color names, we see if the best guess we can come up with for the name of the color, is the same for both
Non-match: if all else fails, the fourth matching level acts as a fallback, that is not really used for anything but to provide the fourth-best-guess. In this case. Read "fallback cases" for more info;


Material type matching
Material type matching is a separate check, that works in unison with the color mapper. You can read more about that here;
Auto-Matching Queue Items to Printers



Magic color name guessing
If you, on your printer or in your slicer, manually select a color in a color picker, and in SimplyPrint select another, they probably aren't 100% the same color code (HEX code, of which there are 16,777,216 different ones!), and often times third party slicers only lets you select the color, but not name it.



But in this case, not all hope is lost. We don't want you to spend a bunch of time mapping colors: that's boring, and takes time away from running your farm.



So, in the case where there are no direct exact matches, we try to find the most suitable name for the given color code, and see if they match for the file and printer material colors.



TLDR; we have a list of hundreds and hundreds of names of colors, then we do some math to find the closest color to the given nameless one; and voilà! We have a name for the color that we can more easily match with!



Nerdy explanation incoming;
We do this by calculating the color distance, using the Delta-E color difference technique, converting the color into the "Lab color space", then calculating the color's Euclidean distance from a huge set of colors with known names.



Fallback cases
If matching fails, and we cannot find a match between the desired file colors and assigned printer material, and even the "magic matching" doesn't work, we have a few cases where we'll take a guess anyway, for your convenience, but without claiming it to be a color-, or any other type of match - simply a pre-selected option, based on what we think you may, would pick anyhow.



Cases of fallbacks;

If the file is a single-color/material print, but the file in SimplyPrint does not have any color tag defined, and your printer only has 1 spool/material assigned, or all its assigned spools/materials are exactly the same color name- and color code-wise; in this case, we either select the first spool, or the currently-active/loaded spool, so no filament change is required.
For 1-click-print; here, if you do not match strictly by matching color, we will simply apply the amount of required materials from first to last spool, regardless of color and type. This means if the print uses 3 materials/colors, and the printer has 3 or more assigned, we will assign spool 1 to the first color, spool 2 to the next and spool 3 to the last. The queue matching criteria for material type, temperatures, custom tags etc. of course still apply, and will discard the item as a match for the given printer if the criteria are not met - but if you only print with 1 color and don't wish to apply color tags to all your files, simply tick off the "Match by color name", and we'll use this fallback-case!
